import { AuditEventSchema, type AuditEvent, type Principal, tenantAuditKey } from "@portal/identity";
import { ManifestSchema } from "@portal/protocol";
import { SatelliteSchema } from "@portal/registry";
import type { Result } from "@portal/registry";
import type { ActionResponse, ScreenResponse } from "@portal/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { buildSurface } from "./surface";
import { invokeTool, type ToolTransport } from "./invoke";

/** Any key will do here; what matters is that one is required. */
const AUDIT_KEY = tenantAuditKey("test-root-key", "acme");

const principal: Principal = {
  sub: "agent@acme.example",
  tenantId: "acme",
  audience: "internal",
  scopes: ["orders.read", "orders.write"],
};

const satellite = SatelliteSchema.parse({
  id: "orders",
  displayName: "Order Management",
  baseUrl: "http://localhost:4001",
  owner: "team",
  rbacScopes: ["orders.read"],
  tools: { "orders.approve": { agentVisible: true, rbacScopes: ["orders.write"] } },
});

const manifest = ManifestSchema.parse({
  protocol: "1.1",
  satelliteId: "orders",
  displayName: "Order Management",
  screens: [{ id: "orders.list", title: "Orders", params: [{ name: "id" }, { name: "q" }] }],
  actions: [
    {
      id: "orders.approve",
      title: "Approve",
      params: [
        { name: "id", type: "string", required: true },
        { name: "quantity", type: "number" },
        { name: "notify", type: "boolean" },
      ],
    },
  ],
});

const surface = buildSurface([{ satellite, manifest }], principal);

const screenResponse: ScreenResponse = {
  protocol: "1.1",
  screen: { id: "orders.list", title: "Orders" },
  ui: {
    type: "Page",
    children: [{ type: "StatTile", props: { label: "Pending", value: "2" } }],
  },
};

const okAction: ActionResponse = {
  protocol: "1.1",
  outcome: "ok",
  toast: { level: "success", message: "Approved." },
};

let audits: AuditEvent[];
let calls: { kind: string; id: string; params: unknown }[];

function transport(over: Partial<ToolTransport> = {}): ToolTransport {
  return {
    fetchScreen: async (_sat, screenId, params) => {
      calls.push({ kind: "screen", id: screenId, params });
      return { ok: true, value: screenResponse } as Result<ScreenResponse>;
    },
    invokeAction: async (_sat, actionId, params) => {
      calls.push({ kind: "action", id: actionId, params });
      return { ok: true, value: okAction } as Result<ActionResponse>;
    },
    ...over,
  };
}

const deps = (over: Partial<ToolTransport> = {}) => ({
  transport: transport(over),
  auditKey: AUDIT_KEY,
  onAudit: (event: AuditEvent) => audits.push(event),
  // Injected so a test asserts a real latency and a real id without a clock.
  now: () => 1_000,
  at: () => "2026-08-16T12:00:00.000Z",
  newId: () => "audit-1",
});

beforeEach(() => {
  audits = [];
  calls = [];
});

describe("reads", () => {
  it("returns the screen as data, not as a tree", () => {
    return invokeTool(surface, "orders__orders_list", {}, principal, deps()).then((result) => {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.kind).toBe("read");
      if (result.kind !== "read") return;
      expect(result.data.stats).toEqual([{ label: "Pending", value: "2" }]);
      expect(JSON.stringify(result)).not.toContain("StatTile");
    });
  });

  it("passes arguments through as screen params, stringified", async () => {
    // A screen param travels in a query string, so `7` and `"7"` are the same
    // request. Rejecting the number would cost a retry and buy nothing — the
    // asymmetry with writes below is deliberate.
    await invokeTool(surface, "orders__orders_list", { id: 7, q: "x" }, principal, deps());
    expect(calls[0]).toEqual({ kind: "screen", id: "orders.list", params: { id: "7", q: "x" } });
  });

  it("refuses an argument the read never declared either", async () => {
    // Undeclared is undeclared. Coercion applies to the *type* of a declared
    // param, never to whether it was declared at all.
    const result = await invokeTool(surface, "orders__orders_list", { tenantId: "globex" }, principal, deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad-arguments");
    expect(calls).toEqual([]);
  });

  it("does not need confirmation", async () => {
    const result = await invokeTool(surface, "orders__orders_list", {}, principal, deps());
    expect(result.ok).toBe(true);
  });
});

describe("writes", () => {
  const approve = (args: Record<string, unknown>, confirmed: boolean) =>
    invokeTool(surface, "orders__orders_approve", args, principal, { ...deps(), confirmed });

  it("refuses to run an unconfirmed write, and does not call the satellite", async () => {
    // The gate is the whole governed-write story. A gateway that executed and
    // *then* reported needing confirmation would have already done the thing.
    const result = await approve({ id: "ord-1" }, false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("needs-confirmation");
    expect(calls).toEqual([]);
  });

  it("runs a confirmed write", async () => {
    const result = await approve({ id: "ord-1" }, true);
    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "write") return;
    expect(result.outcome).toBe("ok");
    expect(result.message).toBe("Approved.");
    expect(calls[0]).toEqual({ kind: "action", id: "orders.approve", params: { id: "ord-1" } });
  });

  it("passes a write's arguments through with their declared types intact", async () => {
    // Unlike a screen param. `{"quantity": 2}` and `{"quantity": "2"}` are
    // different values to a satellite, and the schema said which one it wants.
    await approve({ id: "ord-1", quantity: 2, notify: true }, true);
    expect(calls[0]?.params).toEqual({ id: "ord-1", quantity: 2, notify: true });
  });

  it("reports a validation outcome as a failure the agent can act on", async () => {
    const validation: ActionResponse = {
      protocol: "1.1",
      outcome: "validation",
      fieldErrors: { id: "An order id is required." },
    };
    // A well-formed call the *satellite* rejects — not a malformed one, which
    // never reaches it.
    const result = await invokeTool(surface, "orders__orders_approve", { id: "" }, principal, {
      ...deps({ invokeAction: async () => ({ ok: true, value: validation }) }),
      confirmed: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "write") return;
    expect(result.outcome).toBe("validation");
    expect(result.fieldErrors).toEqual({ id: "An order id is required." });
  });
});

describe("what an agent may not reach", () => {
  it("refuses a tool that is not on this principal's surface", async () => {
    const result = await invokeTool(surface, "orders__nope", {}, principal, deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown-tool");
    expect(calls).toEqual([]);
  });

  it("refuses a tool the principal could not see, by the same answer", async () => {
    // The surface was built for this principal, so a tool they may not call is
    // simply not on it — and is indistinguishable from one that does not
    // exist. That is the same non-disclosure the screen route makes.
    const narrow = buildSurface([{ satellite, manifest }], { ...principal, scopes: [] });
    const result = await invokeTool(narrow, "orders__orders_list", {}, principal, deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown-tool");
  });

  it("refuses an argument the tool never declared", async () => {
    // `additionalProperties: false` is in the schema the model was given, but
    // the schema is a request, not an enforcement. Forwarding an undeclared
    // field would let a model reach a satellite parameter the registry never
    // showed it.
    const result = await invokeTool(
      surface,
      "orders__orders_approve",
      { id: "ord-1", tenantId: "globex" },
      principal,
      { ...deps(), confirmed: true },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad-arguments");
    expect(calls).toEqual([]);
  });

  it("refuses an argument that only matches Object.prototype", async () => {
    // `"constructor" in properties` is true for any plain object, so an
    // undeclared field with that name would pass the check that exists to stop
    // exactly this, and then be dropped without anyone being told.
    const result = await invokeTool(
      surface,
      "orders__orders_approve",
      { id: "ord-1", constructor: "globex" },
      principal,
      { ...deps(), confirmed: true },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad-arguments");
    expect(calls).toEqual([]);
  });

  it("refuses a missing required argument before calling anything", async () => {
    const result = await invokeTool(surface, "orders__orders_approve", { notify: true }, principal, {
      ...deps(),
      confirmed: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad-arguments");
    expect(calls).toEqual([]);
  });

  it("refuses an argument of the wrong declared type", async () => {
    const result = await invokeTool(
      surface,
      "orders__orders_approve",
      { id: 7 },
      principal,
      { ...deps(), confirmed: true },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad-arguments");
  });

  it("refuses a value outside a declared enum", async () => {
    const withEnum = ManifestSchema.parse({
      ...manifest,
      actions: [
        {
          id: "orders.approve",
          title: "Approve",
          params: [{ name: "reason", type: "string", enum: ["late", "fraud"] }],
        },
      ],
    });
    const enumSurface = buildSurface([{ satellite, manifest: withEnum }], principal);
    const result = await invokeTool(
      enumSurface,
      "orders__orders_approve",
      { reason: "whatever" },
      principal,
      { ...deps(), confirmed: true },
    );
    expect(result.ok).toBe(false);
  });
});

describe("audit", () => {
  it("records every call, with a digest of the arguments and not the arguments", async () => {
    await invokeTool(surface, "orders__orders_list", { id: "ord-1" }, principal, deps());
    expect(audits).toHaveLength(1);
    const event = AuditEventSchema.parse(audits[0]);
    expect(event.action.kind).toBe("tool.call");
    expect(event.outcome.status).toBe("ok");
    expect(JSON.stringify(event)).not.toContain("ord-1");
  });

  it("records a refusal, which is the entry that matters most", async () => {
    // "Nothing happened" and "an agent was stopped from doing this" look the
    // same in a log that only records successes.
    await invokeTool(surface, "orders__orders_approve", { id: "x" }, principal, {
      ...deps(),
      confirmed: false,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.outcome.status).toBe("denied");
    expect(audits[0]?.outcome.reason).toBe("needs-confirmation");
  });

  it("records an unknown tool as a denial rather than saying nothing", async () => {
    await invokeTool(surface, "orders__nope", {}, principal, deps());
    expect(audits[0]?.outcome.status).toBe("denied");
  });

  it("records a satellite failure as an error, distinct from a denial", async () => {
    const result = await invokeTool(surface, "orders__orders_list", {}, principal, {
      ...deps({
        fetchScreen: async () => ({ ok: false, reason: "timeout", detail: "took too long" }),
      }),
    });
    expect(result.ok).toBe(false);
    expect(audits[0]?.outcome.status).toBe("error");
    expect(audits[0]?.outcome.reason).toBe("timeout");
  });

  it("never carries the satellite's own error text into the record", async () => {
    // The same rule the proxy follows: upstream detail may name internal paths.
    await invokeTool(surface, "orders__orders_list", {}, principal, {
      ...deps({
        fetchScreen: async () => ({
          ok: false,
          reason: "invalid-response",
          detail: "/srv/internal/orders/handler.ts:88",
        }),
      }),
    });
    expect(JSON.stringify(audits[0])).not.toContain("/srv/internal");
  });
});
