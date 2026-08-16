import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditEvent, Principal } from "@portal/identity";
import { AuditEventSchema } from "@portal/identity";
import { ManifestSchema } from "@portal/protocol";
import { SatelliteClient, SatelliteSchema, loadRegistry } from "@portal/registry";
import { buildSurface, invokeTool, type ToolTransport } from "@portal/mcp-gateway";
import { createApp } from "./app";
import { OrderRepository, seedOrders } from "./repository";

/**
 * The gateway against a real satellite, over a real socket.
 *
 * The unit tests build the surface from hand-written fixtures, which proves the
 * rules and nothing about whether this satellite's actual manifest survives
 * them. This boots the app, reads the manifest it really serves, and calls the
 * tools that fall out of it — including the governed write, twice, to watch the
 * confirmation gate hold and then let go.
 */

const SECRET = "gateway-integration-secret";

const principal = (over: Partial<Principal> = {}): Principal => ({
  sub: "agent@acme.example",
  tenantId: "acme",
  audience: "internal",
  scopes: ["orders.read", "orders.write"],
  ...over,
});

let server: Server;
let repository: OrderRepository;
let client: SatelliteClient;
let transport: ToolTransport;
let baseUrl: string;
const audits: AuditEvent[] = [];

/** The satellite entry as the committed registry file describes it. */
const registryEntry = (baseUrl: string) =>
  loadRegistry(
    `- id: orders
  displayName: Order Management
  baseUrl: ${baseUrl}
  owner: fulfillment-team
  rbacScopes: [orders.read]
  tools:
    orders.approve:
      agentVisible: true
      requiresConfirmation: true
      rbacScopes: [orders.write]
`,
    {},
  )[0];

beforeAll(async () => {
  repository = new OrderRepository(seedOrders());
  const app = createApp({ repository, principalSecret: SECRET });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const satellite = registryEntry(baseUrl);
  if (satellite === undefined) throw new Error("no satellite");

  client = new SatelliteClient({ satellite, principalSecret: SECRET });
  transport = {
    fetchScreen: (_satelliteId, screenId, params, who) => client.fetchScreen(screenId, params, who),
    invokeAction: (_satelliteId, actionId, params, who) =>
      client.invokeAction(actionId, params, who),
  };
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

async function surfaceFor(who: Principal) {
  const satellite = registryEntry(baseUrl);
  if (satellite === undefined) throw new Error("no satellite");

  const manifest = await client.fetchManifest();
  if (!manifest.ok) throw new Error(`manifest unavailable: ${manifest.reason}`);
  return buildSurface([{ satellite, manifest: manifest.value }], who);
}

const deps = (confirmed?: boolean) => ({
  transport,
  onAudit: (event: AuditEvent) => audits.push(event),
  now: () => Date.now(),
  at: () => new Date().toISOString(),
  newId: () => `audit-${audits.length}`,
  ...(confirmed === undefined ? {} : { confirmed }),
});

describe("the surface this satellite actually offers", () => {
  it("projects its real manifest into callable tools", async () => {
    const surface = await surfaceFor(principal());
    expect(surface.tools.map((tool) => tool.name).sort()).toEqual([
      "orders__orders_approve",
      "orders__orders_detail",
      "orders__orders_list",
    ]);
  });

  it("leaves the write nobody enabled off the surface", async () => {
    // `orders.refresh` is a write with no registry entry. Its absence is the
    // default-deny rule working, not an omission.
    const surface = await surfaceFor(principal());
    expect(surface.byName.has("orders__orders_refresh")).toBe(false);
  });

  it("reports nothing as broken", async () => {
    // Every skip is a satellite declaration the gateway could not use. On this
    // satellite there should be none, and a new one appearing means a manifest
    // changed in a way that quietly cost the agent a capability.
    const surface = await surfaceFor(principal());
    expect(surface.skipped).toEqual([]);
  });

  it("marks the enabled write as needing confirmation", async () => {
    const surface = await surfaceFor(principal());
    expect(surface.byName.get("orders__orders_approve")?.requiresConfirmation).toBe(true);
    expect(surface.byName.get("orders__orders_list")?.requiresConfirmation).toBe(false);
  });

  it("hides the write from a principal without the scope the registry demands", async () => {
    const surface = await surfaceFor(principal({ scopes: ["orders.read"] }));
    expect(surface.byName.has("orders__orders_approve")).toBe(false);
    expect(surface.byName.has("orders__orders_list")).toBe(true);
  });

  it("describes every tool with a schema the strict agent path will accept", async () => {
    const surface = await surfaceFor(principal());
    for (const tool of surface.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      for (const rejected of ["minLength", "maximum", "pattern", "format"]) {
        expect(JSON.stringify(tool.inputSchema)).not.toContain(rejected);
      }
    }
  });
});

describe("calling those tools for real", () => {
  it("returns a screen's rows as data rather than as a tree", async () => {
    const surface = await surfaceFor(principal());
    const result = await invokeTool(surface, "orders__orders_list", {}, principal(), deps());

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "read") return;
    const table = result.data.tables[0];
    expect(table?.columns.map((column) => column.key)).toContain("status");
    expect(table?.rows.length).toBeGreaterThan(0);
    // `statusTone` is presentation the satellite sends for the renderer, and it
    // is not a column, so it never reaches the model.
    expect(JSON.stringify(result.data)).not.toContain("statusTone");
  });

  it("passes a declared screen param through to the satellite", async () => {
    const pending = repository.list("acme").find((order) => order.status === "pending");
    const surface = await surfaceFor(principal());
    const result = await invokeTool(
      surface,
      "orders__orders_detail",
      { id: pending?.id ?? "" },
      principal(),
      deps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "read") return;
    expect(result.data.facts.map((fact) => fact.label)).toContain("Customer");
  });

  it("refuses the write until it is confirmed, and changes nothing meanwhile", async () => {
    const pending = repository.list("acme").find((order) => order.status === "pending");
    if (pending === undefined) throw new Error("no pending order to approve");

    const surface = await surfaceFor(principal());
    const refused = await invokeTool(
      surface,
      "orders__orders_approve",
      { id: pending.id },
      principal(),
      deps(false),
    );

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe("needs-confirmation");
    // The point of the gate: the satellite was never called.
    expect(repository.get("acme", pending.id)?.status).toBe("pending");
  });

  it("runs the write once confirmed, and the satellite really changes", async () => {
    const pending = repository.list("acme").find((order) => order.status === "pending");
    if (pending === undefined) throw new Error("no pending order to approve");

    const surface = await surfaceFor(principal());
    const result = await invokeTool(
      surface,
      "orders__orders_approve",
      { id: pending.id },
      principal(),
      deps(true),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "write") return;
    expect(result.outcome).toBe("ok");
    expect(repository.get("acme", pending.id)?.status).toBe("approved");
  });

  it("cannot be talked into sending a parameter the satellite never declared", async () => {
    // The tool schema is what the model was given; it is not what the model is
    // held to. `tenantId` is the field that matters — the satellite scopes on
    // it, and it must come from the signed principal rather than an argument.
    const surface = await surfaceFor(principal());
    const result = await invokeTool(
      surface,
      "orders__orders_approve",
      { id: "ord-1001", tenantId: "globex" },
      principal(),
      deps(true),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad-arguments");
  });

  it("wrote a valid audit record for every one of those calls", async () => {
    // Including the refusals. A log that only records successes cannot tell
    // "nothing happened" from "an agent was stopped".
    expect(audits.length).toBeGreaterThan(0);
    for (const event of audits) expect(() => AuditEventSchema.parse(event)).not.toThrow();
    expect(audits.map((event) => event.outcome.status)).toContain("denied");
    expect(audits.map((event) => event.outcome.status)).toContain("ok");
  });
});

describe("the manifest this satellite serves", () => {
  it("declares parameters for every action, or the agent cannot call them", async () => {
    // The check that would have caught the gap this package was built into: an
    // action with no declared params is invisible to any agent, and nothing
    // about the satellite looks wrong when it happens.
    const manifest = ManifestSchema.parse(await (await fetch(`${baseUrl}/portal/manifest`)).json());
    for (const action of manifest.actions) {
      expect(action.params, `action ${action.id} declares no params`).toBeDefined();
    }
  });

  it("is a satellite the registry schema accepts as written", () => {
    expect(() =>
      SatelliteSchema.parse({
        id: "orders",
        displayName: "Order Management",
        baseUrl: "http://localhost:4001",
        owner: "fulfillment-team",
        tools: { "orders.approve": { agentVisible: true, requiresConfirmation: true } },
      }),
    ).not.toThrow();
  });
});
