import { tenantAuditKey, type AuditEvent, type Principal } from "@portal/identity";
import { ManifestSchema } from "@portal/protocol";
import { SatelliteSchema } from "@portal/registry";
import { beforeEach, describe, expect, it } from "vitest";
import type { McpCallOutcome, SatelliteMcpTool } from "./client";
import { invokeTool, type InvokeDeps, type ToolTransport } from "./invoke";
import { buildSurface, type ToolSurface } from "./surface";

/**
 * The MCP half of `invokeTool`.
 *
 * These exist because the two paths diverge on exactly one thing — who checks
 * the arguments — and it would be easy to let that divergence quietly widen
 * into "and who checks the entitlement", which is not on offer. So the first
 * tests here are the *shared* rules, asserted against an MCP tool: scopes,
 * confirmation, and audit behave identically, and only validation moves.
 */

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
  mcpUrl: "http://localhost:4001/mcp",
  owner: "team",
  rbacScopes: ["orders.read"],
  tools: {
    "orders.reconcile": { agentVisible: true, rbacScopes: ["orders.write"] },
    "orders.search": { agentVisible: true },
  },
});

/** A nested schema — the shape PUP cannot express, which is why it is here. */
const searchTool: SatelliteMcpTool = {
  name: "orders.search",
  title: "Search orders",
  description: "Structured search with nested filters.",
  inputSchema: {
    type: "object",
    properties: {
      filters: {
        type: "object",
        properties: {
          status: { type: "array", items: { type: "string" } },
          placed: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } } },
        },
      },
    },
  },
  readOnly: true,
};

const reconcileTool: SatelliteMcpTool = {
  name: "orders.reconcile",
  title: "Reconcile orders",
  description: "Rewrites blocked orders against current stock.",
  inputSchema: { type: "object", properties: { dryRun: { type: "boolean" } } },
  readOnly: false,
};

const transport: ToolTransport = {
  fetchScreen: async () => {
    throw new Error("an MCP tool must not reach the screen path");
  },
  invokeAction: async () => {
    throw new Error("an MCP tool must not reach the action path");
  },
};

let audits: AuditEvent[];
let mcpCalls: { toolName: string; args: unknown; principal: Principal }[];

/**
 * A satellite with no screens at all.
 *
 * Deliberately empty: every tool in this file exists only because the satellite
 * hosts an MCP server, which is the case the shim cannot reach.
 */
const manifest = ManifestSchema.parse({
  protocol: "1.1",
  satelliteId: "orders",
  displayName: "Order Management",
  screens: [],
  actions: [],
});

// Built through the real surface builder, not a hand-made map, because
// entitlement lives there. A fake surface would let these tests pass while the
// tools were unreachable — or reachable by the wrong principal.
const surfaceOf = (mcpTools: readonly SatelliteMcpTool[], who: Principal = principal): ToolSurface =>
  buildSurface([{ satellite, manifest, mcpTools }], who);

const deps = (outcome: McpCallOutcome, over: Partial<InvokeDeps> = {}): InvokeDeps => ({
  transport,
  auditKey: AUDIT_KEY,
  onAudit: (event: AuditEvent) => audits.push(event),
  now: () => 1_000,
  at: () => "2026-08-19T12:00:00.000Z",
  newId: () => "audit-1",
  callMcpTool: async (_satelliteId, toolName, args, who) => {
    mcpCalls.push({ toolName, args, principal: who });
    return outcome;
  },
  ...over,
});

const ok = (over: Partial<Extract<McpCallOutcome, { ok: true }>> = {}): McpCallOutcome => ({
  ok: true,
  content: "",
  ...over,
});

beforeEach(() => {
  audits = [];
  mcpCalls = [];
});

describe("an MCP read", () => {
  it("passes nested arguments through untouched", async () => {
    const args = { filters: { status: ["blocked", "held"], placed: { from: "2026-01-01" } } };
    const surface = surfaceOf([searchTool]);

    const result = await invokeTool(surface, "orders__orders_search", args, principal, deps(ok()));

    expect(result.ok).toBe(true);
    expect(mcpCalls[0]?.toolName).toBe("orders.search");
    // Not flattened, not coerced, not stripped. A PUP tool would have refused
    // this outright — `filters` is not a scalar param and never could be.
    expect(mcpCalls[0]?.args).toEqual(args);
  });

  it("carries the principal to the satellite, which authorizes for itself", async () => {
    await invokeTool(surfaceOf([searchTool]), "orders__orders_search", {}, principal, deps(ok()));
    expect(mcpCalls[0]?.principal.tenantId).toBe("acme");
  });

  it("returns structured content as data the grounding validator can check", async () => {
    const result = await invokeTool(
      surfaceOf([searchTool]),
      "orders__orders_search",
      {},
      principal,
      deps(ok({ structured: { matches: [{ id: "A-1", status: "blocked" }], total: 1 } })),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "read") throw new Error("expected a read");
    expect(result.data.tables[0]?.rows).toEqual([{ id: "A-1", status: "blocked" }]);
    expect(result.data.facts).toEqual([{ label: "total", value: "1" }]);
  });
});

describe("an MCP write", () => {
  it("does not run until it is confirmed", async () => {
    const result = await invokeTool(
      surfaceOf([reconcileTool]),
      "orders__orders_reconcile",
      { dryRun: false },
      principal,
      deps(ok()),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("needs-confirmation");
    // The gate is worth nothing if the call already happened behind it.
    expect(mcpCalls).toHaveLength(0);
  });

  it("runs once confirmed, and reports the tool's own text", async () => {
    const result = await invokeTool(
      surfaceOf([reconcileTool]),
      "orders__orders_reconcile",
      { dryRun: false },
      principal,
      deps(ok({ content: "Reconciled 3 orders." }), { confirmed: true }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "write") throw new Error("expected a write");
    expect(result.outcome).toBe("ok");
    expect(result.message).toBe("Reconciled 3 orders.");
    expect(mcpCalls).toHaveLength(1);
  });

  it("is not on the surface at all for a principal lacking the scope", async () => {
    const unscoped: Principal = { ...principal, scopes: ["orders.read"] };
    const surface = surfaceOf([reconcileTool], unscoped);

    expect(surface.byName.has("orders__orders_reconcile")).toBe(false);

    const result = await invokeTool(
      surface,
      "orders__orders_reconcile",
      {},
      unscoped,
      deps(ok(), { confirmed: true }),
    );

    // Entitlement is the gateway's, not the satellite's schema's. Passing
    // arguments through must never have meant passing the caller through — and
    // an unentitled tool is *absent*, not refused, so nothing is disclosed by
    // asking for it.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown-tool");
    expect(mcpCalls).toHaveLength(0);
  });
});

describe("when the satellite says no", () => {
  it("passes a tool's own refusal to the model", async () => {
    const result = await invokeTool(
      surfaceOf([searchTool]),
      "orders__orders_search",
      { filters: { status: 5 } },
      principal,
      deps({ ok: false, kind: "refused", message: "filters.status must be a list of strings" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The satellite validated what the gateway declined to. Losing its message
    // would leave the model with nothing to correct.
    expect(result.message).toBe("filters.status must be a list of strings");
  });

  it("withholds the detail of a transport failure", async () => {
    const result = await invokeTool(
      surfaceOf([searchTool]),
      "orders__orders_search",
      {},
      principal,
      deps({ ok: false, kind: "unreachable", message: "connect ECONNREFUSED 10.4.2.11:4001" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain("10.4.2.11");
    expect(result.reason).toBe("upstream-error");
  });

  it("refuses rather than falling through to PUP when no client was configured", async () => {
    const { callMcpTool: _omitted, ...withoutClient } = deps(ok());
    const result = await invokeTool(
      surfaceOf([searchTool]),
      "orders__orders_search",
      {},
      principal,
      withoutClient,
    );

    // The transport above throws if the screen path is reached, so this failing
    // as `upstream-error` rather than exploding is the assertion.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("upstream-error");
  });
});

describe("audit", () => {
  it("records an MCP call the same way it records a screen call", async () => {
    await invokeTool(
      surfaceOf([searchTool]),
      "orders__orders_search",
      { filters: { status: ["blocked"] } },
      principal,
      deps(ok()),
    );

    expect(audits).toHaveLength(1);
    expect(audits[0]?.action.kind).toBe("tool.call");
    expect(audits[0]?.outcome.status).toBe("ok");
    // Digested, never stored — the same rule the screen path follows, and the
    // reason an MCP tool's nested arguments are safe to pass through at all.
    expect(JSON.stringify(audits[0])).not.toContain("blocked");
  });

  it("says whether the satellite refused or could not be reached", async () => {
    await invokeTool(
      surfaceOf([searchTool]),
      "orders__orders_search",
      {},
      principal,
      deps({ ok: false, kind: "refused", message: "missing scope orders.read" }),
    );
    await invokeTool(
      surfaceOf([searchTool]),
      "orders__orders_search",
      {},
      principal,
      deps({ ok: false, kind: "unreachable", message: "connect ECONNREFUSED" }),
    );

    // A satellite that ran the tool and said no is "an agent was stopped from
    // doing this"; a satellite that never answered is an outage. A log that
    // spells them the same way cannot be asked which one happened.
    expect(audits.map((event) => event.outcome.reason)).toEqual(["refused", "upstream-error"]);
  });
});

describe("when a satellite offers the same id twice", () => {
  it("drops both rather than picking one", () => {
    // A satellite with a screen called `orders.list` and an MCP tool called
    // `orders.list` has two different things answering to one name. Resolving
    // it by build order would mean the agent's tool silently changed meaning
    // the day the satellite added an MCP server.
    const withScreen = ManifestSchema.parse({
      protocol: "1.1",
      satelliteId: "orders",
      displayName: "Order Management",
      screens: [{ id: "orders.search", title: "Search" }],
      actions: [],
    });

    const surface = buildSurface(
      [{ satellite, manifest: withScreen, mcpTools: [searchTool] }],
      principal,
    );

    expect(surface.byName.has("orders__orders_search")).toBe(false);
    expect(surface.skipped.filter((skip) => skip.toolId === "orders.search")).toHaveLength(2);
  });
});
