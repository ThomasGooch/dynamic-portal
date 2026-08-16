import { describe, expect, it } from "vitest";
import type { Principal } from "@portal/identity";
import { loadRegistry, resolveNav, visibleSatellites } from "./registry";

const YAML = `
- id: orders
  displayName: Order Management
  baseUrl: http://localhost:4001
  owner: fulfillment-team
  nav: { section: Operations, order: 10 }
  rbacScopes: [orders.read]
  timeoutMs: 3000
- id: fleet
  displayName: Fleet Operations
  baseUrl: http://localhost:4002
  owner: logistics-team
  audience: [internal, external]
  nav: { section: Operations, order: 20 }
  rbacScopes: [fleet.read]
`;

const principal = (over: Partial<Principal> = {}): Principal => ({
  sub: "alice@acme.example",
  tenantId: "acme",
  audience: "internal",
  scopes: ["orders.read", "fleet.read"],
  ...over,
});

describe("loadRegistry", () => {
  it("parses a well-formed registry", () => {
    const registry = loadRegistry(YAML);
    expect(registry.map((s) => s.id)).toEqual(["orders", "fleet"]);
  });

  it("defaults an omitted audience to internal-only", () => {
    // Same rule as the protocol: a satellite that forgets to declare an
    // audience must never become externally visible.
    expect(loadRegistry(YAML)[0]?.audience).toEqual(["internal"]);
  });

  it("honours an explicit external audience", () => {
    expect(loadRegistry(YAML)[1]?.audience).toEqual(["internal", "external"]);
  });

  it("applies a default timeout so a satellite cannot hang the hub by omission", () => {
    const fleet = loadRegistry(YAML)[1];
    expect(fleet?.timeoutMs).toBeGreaterThan(0);
  });

  it("rejects a duplicate satellite id", () => {
    expect(() => loadRegistry(`${YAML}\n- id: orders\n  displayName: Dup\n  baseUrl: http://x.example\n  owner: t\n`)).toThrow(
      /duplicate/i,
    );
  });

  it("rejects an unknown field, so the config cannot drift silently", () => {
    expect(() =>
      loadRegistry("- id: a\n  displayName: A\n  baseUrl: http://a.example\n  owner: t\n  surprise: 1\n"),
    ).toThrow();
  });

  it.each([
    ["javascript:alert(1)", "a script URL"],
    ["file:///etc/passwd", "a file URL"],
    ["data:text/html,x", "a data URL"],
    ["not a url", "nonsense"],
  ])("rejects baseUrl %s (%s)", (baseUrl) => {
    // The hub dereferences baseUrl on every request. Same finding as the
    // protocol's mcpUrl and the catalog's Link.href — the third time this
    // shape of bug would have been possible, so it gets a test up front.
    expect(() =>
      loadRegistry(`- id: a\n  displayName: A\n  baseUrl: ${JSON.stringify(baseUrl)}\n  owner: t\n`),
    ).toThrow();
  });

  it("rejects a tool exposed to an audience its satellite is not", () => {
    // Default-deny holds downwards, as it does in the manifest: otherwise an
    // internal-only satellite could mark a tool ["external"], and a projection
    // filtering on the tool's own audience would publish it outside the org.
    expect(() =>
      loadRegistry(
        "- id: a\n  displayName: A\n  baseUrl: http://a.example\n  owner: t\n  audience: [internal]\n  tools:\n    a.approve:\n      audience: [external]\n",
      ),
    ).toThrow(/audience/i);
  });

  it("rejects a tool id that is not an id", () => {
    // Tool ids are projected into MCP tool names, so they are held to the same
    // shape as every other id rather than accepted as arbitrary strings.
    expect(() =>
      loadRegistry(
        '- id: a\n  displayName: A\n  baseUrl: http://a.example\n  owner: t\n  tools:\n    "  Not An Id!":\n      rbacScopes: []\n',
      ),
    ).toThrow();
  });

  it("rejects an empty registry rather than starting with no satellites", () => {
    expect(() => loadRegistry("[]")).toThrow();
  });

  it("reports which entry is wrong, not merely that one is", () => {
    try {
      loadRegistry("- id: ok\n  displayName: A\n  baseUrl: http://a.example\n  owner: t\n- id: BAD ID\n  displayName: B\n  baseUrl: http://b.example\n  owner: t\n");
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as Error).message).toMatch(/1/);
    }
  });
});

describe("visibility", () => {
  const registry = loadRegistry(YAML);

  it("shows an internal principal everything it has scopes for", () => {
    expect(visibleSatellites(registry, principal()).map((s) => s.id)).toEqual([
      "orders",
      "fleet",
    ]);
  });

  it("hides a satellite the principal lacks scopes for", () => {
    const visible = visibleSatellites(registry, principal({ scopes: ["orders.read"] }));
    expect(visible.map((s) => s.id)).toEqual(["orders"]);
  });

  it("hides an internal-only satellite from an external principal", () => {
    const visible = visibleSatellites(registry, principal({ audience: "external" }));
    expect(visible.map((s) => s.id)).toEqual(["fleet"]);
  });

  it("shows nothing to a principal with no scopes", () => {
    expect(visibleSatellites(registry, principal({ scopes: [] }))).toEqual([]);
  });
});

describe("resolveNav", () => {
  const registry = loadRegistry(YAML);

  it("groups by section and orders within it", () => {
    const nav = resolveNav(registry, principal());
    expect(nav).toEqual([
      {
        section: "Operations",
        items: [
          { satelliteId: "orders", label: "Order Management", order: 10 },
          { satelliteId: "fleet", label: "Fleet Operations", order: 20 },
        ],
      },
    ]);
  });

  it("omits a section that becomes empty after filtering", () => {
    // An empty section heading tells a user something exists that they cannot
    // reach, which is both confusing and a small disclosure.
    const nav = resolveNav(registry, principal({ scopes: [] }));
    expect(nav).toEqual([]);
  });

  it("places a satellite with no nav block in a default section", () => {
    const nav = resolveNav(
      loadRegistry("- id: a\n  displayName: A\n  baseUrl: http://a.example\n  owner: t\n"),
      principal({ scopes: [] , audience: "internal" }),
    );
    // No rbacScopes declared means nothing is required, so it stays visible.
    expect(nav[0]?.items[0]?.satelliteId).toBe("a");
  });
});
