import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "@portal/identity";
import { SatelliteSchema } from "@portal/registry";
import { callSatelliteTool, listSatelliteTools } from "@portal/mcp-gateway";
import { createApp } from "./app";
import { OrderRepository, seedOrders } from "./repository";

/**
 * The satellite's own MCP server, reached through the hub's real gateway client.
 *
 * This is the test that has to justify the whole feature. Every tool here must
 * be something the PUP shim *cannot* produce — otherwise the satellite has
 * taken on a second server to reach exactly what it already had. So:
 *
 *   - `orders.search` takes a nested query. A PUP action parameter is a scalar
 *     or a list of them, by design, and widening it would cost the protocol,
 *     the shim, the validator, the façade and three SDKs.
 *   - `orders.reconcile` has no screen at all. There is nothing to render, so
 *     there is nothing for the shim to find.
 *
 * Both return `structuredContent`, which is the other half: the shim recovers
 * data by reading a rendered table, and this hands the data over directly.
 */

const SECRET = "mcp-integration-secret";

const principal = (over: Partial<Principal> = {}): Principal => ({
  sub: "agent@acme.example",
  tenantId: "acme",
  audience: "internal",
  scopes: ["orders.read", "orders.write"],
  ...over,
});

let server: Server;
let repository: OrderRepository;
let satellite: ReturnType<typeof SatelliteSchema.parse>;

beforeEach(() => {
  // The reconcile tool writes, so each test needs the seed back.
  repository.reset(seedOrders());
});

beforeAll(async () => {
  repository = new OrderRepository(seedOrders());
  const app = createApp({ repository, principalSecret: SECRET });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");

  satellite = SatelliteSchema.parse({
    id: "orders",
    displayName: "Order Management",
    baseUrl: `http://127.0.0.1:${address.port}`,
    mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
    owner: "fulfillment-team",
    rbacScopes: ["orders.read"],
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

const options = { principalSecret: SECRET };

describe("listing", () => {
  it("offers tools the shim could not have produced", async () => {
    const listed = await listSatelliteTools(satellite, principal(), options);

    expect(listed.reason).toBeUndefined();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "orders.reconcile",
      "orders.search",
    ]);
  });

  it("marks the search read-only and the reconcile not", async () => {
    const listed = await listSatelliteTools(satellite, principal(), options);
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));

    // The gateway turns this into `kind` and, with it, whether a confirmation
    // card stands between the model and the change.
    expect(byName.get("orders.search")?.readOnly).toBe(true);
    expect(byName.get("orders.reconcile")?.readOnly).toBe(false);
  });

  it("publishes a genuinely nested input schema", async () => {
    const listed = await listSatelliteTools(satellite, principal(), options);
    const schema = listed.tools.find((tool) => tool.name === "orders.search")?.inputSchema as {
      properties?: { filters?: { properties?: Record<string, unknown> } };
    };

    // If this ever flattens, the tool has stopped being a reason to run an MCP
    // server and the gateway should go back to shimming it.
    expect(Object.keys(schema.properties?.filters?.properties ?? {}).sort()).toEqual([
      "placedBetween",
      "priority",
      "status",
    ]);
  });

  it("refuses a principal from an audience this satellite is not declared to", async () => {
    // The satellite's manifest says `internal`, and every PUP route resolves
    // that before it answers — the conformance suite has a check named for it.
    // An MCP door that skipped it would be the same data behind a weaker lock,
    // which is the failure this file's header names out loud.
    const listed = await listSatelliteTools(satellite, principal({ audience: "external" }), options);
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "orders.reconcile",
      "orders.search",
    ]);

    const result = await callSatelliteTool(
      satellite,
      principal({ audience: "external" }),
      options,
      "orders.search",
      { filters: {} },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("refused");
  });

  it("gives up on a satellite that answers nothing, rather than holding the turn", async () => {
    // Not the dead-port case, which fails fast on its own: a port that accepts
    // the connection and then says nothing. The surface is rebuilt on every
    // agent turn, so an unbounded wait here is one stopped satellite holding up
    // every request in the hub — which is the failure `timeoutMs` exists in the
    // registry to bound.
    const silent = createServer(() => {
      /* accepts the request and never answers */
    });
    await new Promise<void>((resolve) => silent.listen(0, resolve));
    const address = silent.address();
    if (address === null || typeof address === "string") throw new Error("no port");

    const stalled = SatelliteSchema.parse({
      id: "orders",
      displayName: "Order Management",
      baseUrl: `http://127.0.0.1:${address.port}`,
      mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
      owner: "fulfillment-team",
    });

    const started = Date.now();
    const listed = await listSatelliteTools(stalled, principal(), {
      ...options,
      timeoutMs: 150,
    });

    expect(listed.tools).toEqual([]);
    expect(listed.reason).toBeDefined();
    expect(Date.now() - started).toBeLessThan(3_000);
    await new Promise<void>((resolve) => {
      silent.closeAllConnections();
      silent.close(() => resolve());
    });
  });

  it("refuses a caller with no credential", async () => {
    const listed = await listSatelliteTools(
      satellite,
      principal(),
      { principalSecret: "the-wrong-secret" },
    );

    // A satellite's MCP surface is the same data behind a different door. A
    // door that opened without the signature would be the hole.
    expect(listed.tools).toEqual([]);
    expect(listed.reason).toBeDefined();
  });
});

describe("search", () => {
  it("filters on a nested query and returns rows, not a rendered screen", async () => {
    const result = await callSatelliteTool(satellite, principal(), options, "orders.search", {
      filters: { status: ["pending", "shipped"] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const matches = result.structured?.["matches"] as { id: string }[];
    // ord-1003 is acme's third, and pending. The two globex orders are absent
    // whatever the filter says — see the tenant test below.
    expect(matches.map((order) => order.id).sort()).toEqual([
      "ord-1001",
      "ord-1002",
      "ord-1003",
    ]);
    // Handed over, not extracted from a table component.
    expect(result.structured?.["total"]).toBe(3);
  });

  it("combines the nested branches rather than honouring only the first", async () => {
    const result = await callSatelliteTool(satellite, principal(), options, "orders.search", {
      filters: {
        status: ["pending", "approved", "shipped"],
        priority: ["critical"],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.structured?.["matches"] as { id: string }[]).map((o) => o.id)).toEqual([
      "ord-1001",
    ]);
  });

  it("filters on a date range, which is a nested object of its own", async () => {
    const result = await callSatelliteTool(satellite, principal(), options, "orders.search", {
      filters: { placedBetween: { from: "2026-08-11", to: "2026-08-12" } },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // ord-1001 was placed on the 10th and falls outside; `to` includes the
    // whole of the 12th, so ord-1003 at 08:30 that day is in.
    expect((result.structured?.["matches"] as { id: string }[]).map((o) => o.id)).toEqual([
      "ord-1002",
      "ord-1003",
    ]);
  });

  it("never returns another tenant's orders, whatever the filter says", async () => {
    const result = await callSatelliteTool(satellite, principal(), options, "orders.search", {
      filters: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = (result.structured?.["matches"] as { id: string }[]).map((order) => order.id);
    // globex's orders are `ord-2xxx`. The satellite authorizes for itself here
    // exactly as it does on the PUP path — the hub is not the thing keeping
    // tenants apart.
    expect(ids.every((id) => id.startsWith("ord-1"))).toBe(true);
  });

  it("refuses a search from a principal without the read scope", async () => {
    const result = await callSatelliteTool(
      satellite,
      principal({ scopes: [] }),
      options,
      "orders.search",
      { filters: {} },
    );

    expect(result.ok).toBe(false);
  });

  it("validates its own arguments, since the gateway passed them through", async () => {
    const result = await callSatelliteTool(satellite, principal(), options, "orders.search", {
      filters: { status: "pending" },
    });

    // A string where a list belongs. The gateway never looked; this is the
    // satellite holding up its end of that bargain.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("refused");
  });
});

describe("reconcile", () => {
  it("clears blocks for vehicles that are back in service", async () => {
    const result = await callSatelliteTool(satellite, principal(), options, "orders.reconcile", {
      vehiclesBackInService: ["veh-77"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.structured?.["cleared"]).toEqual(["ord-1001"]);
    expect(repository.get("acme", "ord-1001")?.blockedByVehicleId).toBeUndefined();
  });

  it("changes nothing on a dry run, and says what it would have done", async () => {
    const result = await callSatelliteTool(satellite, principal(), options, "orders.reconcile", {
      vehiclesBackInService: ["veh-77"],
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.structured?.["cleared"]).toEqual(["ord-1001"]);
    expect(result.structured?.["dryRun"]).toBe(true);
    expect(repository.get("acme", "ord-1001")?.blockedByVehicleId).toBe("veh-77");
  });

  it("will not reconcile another tenant's orders", async () => {
    // `ord-2002` is globex's, and is the only order blocked by `veh-12`. An
    // acme principal asking to reconcile that vehicle is the bulk-operation
    // version of a cross-tenant write, which is the one most able to happen
    // quietly — a reconcile touches every record it matches.
    const result = await callSatelliteTool(satellite, principal(), options, "orders.reconcile", {
      vehiclesBackInService: ["veh-12"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Succeeded and did nothing, rather than failing. The satellite has no
    // reason to tell acme that a globex order exists.
    expect(result.structured?.["cleared"]).toEqual([]);
    expect(repository.get("globex", "ord-2002")?.blockedByVehicleId).toBe("veh-12");
  });

  it("refuses a reconcile from a principal with only the read scope", async () => {
    const result = await callSatelliteTool(
      satellite,
      principal({ scopes: ["orders.read"] }),
      options,
      "orders.reconcile",
      { vehiclesBackInService: ["veh-77"] },
    );

    expect(result.ok).toBe(false);
    expect(repository.get("acme", "ord-1001")?.blockedByVehicleId).toBe("veh-77");
  });
});
