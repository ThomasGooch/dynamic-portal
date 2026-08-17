import type { Principal } from "@portal/identity";
import { ManifestSchema } from "@portal/protocol";
import { SatelliteSchema } from "@portal/registry";
import { describe, expect, it } from "vitest";
import { buildSurface } from "./surface";

const principal = (over: Partial<Principal> = {}): Principal => ({
  sub: "dev@acme.example",
  tenantId: "acme",
  audience: "internal",
  scopes: ["orders.read", "orders.write", "fleet.read"],
  ...over,
});

const entry = (
  satelliteOver: Record<string, unknown>,
  manifestOver: Record<string, unknown>,
) => ({
  satellite: SatelliteSchema.parse({
    id: "orders",
    displayName: "Order Management",
    baseUrl: "http://localhost:4001",
    owner: "team",
    rbacScopes: ["orders.read"],
    ...satelliteOver,
  }),
  manifest: ManifestSchema.parse({
    protocol: "1.1",
    satelliteId: "orders",
    displayName: "Order Management",
    screens: [{ id: "orders.list", title: "Orders" }],
    actions: [],
    ...manifestOver,
  }),
});

const names = (surface: ReturnType<typeof buildSurface>) => surface.tools.map((t) => t.name).sort();

describe("buildSurface", () => {
  it("offers the reads a principal is entitled to", () => {
    expect(names(buildSurface([entry({}, {})], principal()))).toEqual(["orders__orders_list"]);
  });

  it("withholds a tool whose scopes the principal lacks", () => {
    // The same predicate the screen route uses. A gateway with its own idea of
    // who may read what is a second policy engine, and two policy engines
    // disagree eventually.
    const surface = buildSurface([entry({}, {})], principal({ scopes: ["fleet.read"] }));
    expect(surface.tools).toEqual([]);
  });

  it("withholds a tool from the wrong audience", () => {
    const surface = buildSurface([entry({}, {})], principal({ audience: "external" }));
    expect(surface.tools).toEqual([]);
  });

  it("withholds a write nobody enabled", () => {
    const surface = buildSurface(
      [entry({}, { actions: [{ id: "orders.approve", params: [{ name: "id", type: "string" }] }] })],
      principal(),
    );
    expect(names(surface)).toEqual(["orders__orders_list"]);
  });

  it("offers a write the registry enabled", () => {
    const surface = buildSurface(
      [
        entry(
          { tools: { "orders.approve": { agentVisible: true, rbacScopes: ["orders.write"] } } },
          { actions: [{ id: "orders.approve", params: [{ name: "id", type: "string" }] }] },
        ),
      ],
      principal(),
    );
    expect(names(surface)).toEqual(["orders__orders_approve", "orders__orders_list"]);
    expect(surface.byName.get("orders__orders_approve")?.requiresConfirmation).toBe(true);
  });

  it("withholds an enabled write from a principal without its scope", () => {
    // Enabling a tool in the registry says the *agent* may call it. It says
    // nothing about who the agent is acting for.
    const surface = buildSurface(
      [
        entry(
          { tools: { "orders.approve": { agentVisible: true, rbacScopes: ["orders.write"] } } },
          { actions: [{ id: "orders.approve", params: [{ name: "id", type: "string" }] }] },
        ),
      ],
      principal({ scopes: ["orders.read"] }),
    );
    expect(names(surface)).toEqual(["orders__orders_list"]);
  });

  it("indexes tools by the name an agent will call them by", () => {
    const surface = buildSurface([entry({}, {})], principal());
    expect(surface.byName.get("orders__orders_list")?.targetId).toBe("orders.list");
  });

  it("keeps two satellites' identically-named tools apart", () => {
    const fleet = entry(
      { id: "fleet", displayName: "Fleet", rbacScopes: ["fleet.read"] },
      { satelliteId: "fleet", displayName: "Fleet", screens: [{ id: "search", title: "Search" }] },
    );
    const orders = entry({}, { screens: [{ id: "search", title: "Search" }] });
    expect(names(buildSurface([orders, fleet], principal()))).toEqual([
      "fleet__search",
      "orders__search",
    ]);
  });

  it("drops both when two satellites' ids project onto one namespace", () => {
    // `a.b` and `a_b` are both valid satellite ids and the same MCP prefix.
    // Within one satellite the shim catches this; across two, only here.
    const a = entry(
      { id: "a.b", rbacScopes: [] },
      { satelliteId: "a.b", screens: [{ id: "run", title: "Run" }] },
    );
    const b = entry(
      { id: "a_b", rbacScopes: [] },
      { satelliteId: "a_b", screens: [{ id: "run", title: "Run" }] },
    );
    const surface = buildSurface([a, b], principal());
    expect(surface.tools).toEqual([]);
    expect(surface.skipped.map((s) => s.satelliteId).sort()).toEqual(["a.b", "a_b"]);
  });

  it("reports what it left out, and which satellite it came from", () => {
    const surface = buildSurface(
      [entry({}, { actions: [{ id: "orders.approve" }] })],
      principal(),
    );
    expect(surface.skipped).toEqual([
      {
        satelliteId: "orders",
        toolId: "orders.approve",
        reason: "action declares no parameters, so no agent can call it",
      },
    ]);
  });

  it("does not report a deliberately disabled tool as a problem", () => {
    // "Not enabled" is the resting state of every write. Reporting it as
    // skipped would bury the ones that are actually broken.
    const surface = buildSurface(
      [entry({}, { actions: [{ id: "orders.approve", params: [{ name: "id", type: "string" }] }] })],
      principal(),
    );
    expect(surface.skipped).toEqual([]);
  });

  it("survives a satellite with no tools at all", () => {
    const surface = buildSurface(
      [entry({}, { screens: [], actions: [] })],
      principal(),
    );
    expect(surface.tools).toEqual([]);
    expect(surface.skipped).toEqual([]);
  });
});
