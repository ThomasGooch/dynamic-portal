import type { Principal } from "@portal/identity";
import { ManifestSchema } from "@portal/protocol";
import { SatelliteSchema } from "@portal/registry";
import { describe, expect, it } from "vitest";
import { PUBLIC_API_VERSION, buildCatalog, resolveOperation, resolveResource } from "./catalog";

const external: Principal = {
  sub: "partner@acme-customer.example",
  tenantId: "acme-customer",
  audience: "external",
  scopes: ["orders.read"],
};

const internal: Principal = { ...external, audience: "internal", sub: "staff@acme.example" };

const entry = (satelliteOver: Record<string, unknown> = {}, manifestOver: Record<string, unknown> = {}) => ({
  satellite: SatelliteSchema.parse({
    id: "orders",
    displayName: "Order Management",
    description: "Track orders.",
    baseUrl: "http://localhost:4001",
    owner: "team",
    audience: ["internal", "external"],
    rbacScopes: ["orders.read"],
    public: {
      service: "order-management",
      resources: [
        { name: "orders", screenId: "orders.list" },
        { name: "order", screenId: "orders.detail" },
      ],
      operations: [{ name: "approve", actionId: "orders.approve" }],
    },
    ...satelliteOver,
  }),
  manifest: ManifestSchema.parse({
    protocol: "1.1",
    satelliteId: "orders",
    displayName: "Order Management",
    audience: ["internal", "external"],
    screens: [
      { id: "orders.list", title: "Orders", description: "All orders.", audience: ["internal", "external"] },
      {
        id: "orders.detail",
        title: "Order detail",
        params: [{ name: "id", required: true, description: "Order id" }],
        audience: ["internal", "external"],
      },
    ],
    actions: [
      {
        id: "orders.approve",
        title: "Approve order",
        params: [{ name: "id", type: "string", required: true }],
        audience: ["internal", "external"],
      },
    ],
    ...manifestOver,
  }),
});

describe("the catalog an external client sees", () => {
  it("names things publicly, never by their internal ids", () => {
    // The point of the mapping. If `orders.list` appeared here, renaming a
    // screen would break every client and the separate versioning would be
    // decoration.
    const catalog = buildCatalog([entry()], external);
    const text = JSON.stringify(catalog);

    expect(catalog.services[0]?.name).toBe("order-management");
    expect(catalog.services[0]?.resources.map((r) => r.name)).toEqual(["orders", "order"]);
    expect(text).not.toContain("orders.list");
    expect(text).not.toContain("orders.detail");
    expect(text).not.toContain("orders.approve");
  });

  it("carries its own version, not the protocol's or the catalog's", () => {
    expect(buildCatalog([entry()], external).version).toBe(PUBLIC_API_VERSION);
  });

  it("describes the parameters a resource takes", () => {
    const detail = buildCatalog([entry()], external).services[0]?.resources[1];
    expect(detail?.params).toEqual([
      { name: "id", required: true, description: "Order id" },
    ]);
  });

  it("describes an operation's typed parameters", () => {
    const approve = buildCatalog([entry()], external).services[0]?.operations[0];
    expect(approve?.params).toEqual([{ name: "id", type: "string", required: true }]);
  });
});

describe("default-deny, at the outermost edge", () => {
  it("omits a satellite with no public projection at all", () => {
    const catalog = buildCatalog([entry({ public: undefined })], external);
    expect(catalog.services).toEqual([]);
  });

  it("omits a screen the manifest did not mark external", () => {
    // Declared in the registry's projection and still absent, because the
    // satellite never agreed to publish it. Both have to say yes.
    const catalog = buildCatalog(
      [
        entry(
          {},
          {
            screens: [
              { id: "orders.list", title: "Orders", audience: ["internal", "external"] },
              { id: "orders.detail", title: "Order detail", audience: ["internal"] },
            ],
          },
        ),
      ],
      external,
    );
    expect(catalog.services[0]?.resources.map((r) => r.name)).toEqual(["orders"]);
  });

  it("omits an operation the manifest kept internal", () => {
    const catalog = buildCatalog(
      [
        entry(
          {},
          {
            actions: [
              {
                id: "orders.approve",
                title: "Approve",
                params: [{ name: "id", type: "string" }],
                audience: ["internal"],
              },
            ],
          },
        ),
      ],
      external,
    );
    expect(catalog.services[0]?.operations).toEqual([]);
  });

  it("omits a resource the projection names but the manifest does not have", () => {
    // A screen deleted by a satellite team leaves a dangling public name. It
    // disappears from the catalog rather than 404ing at call time.
    const catalog = buildCatalog(
      [entry({}, { screens: [{ id: "orders.list", title: "Orders", audience: ["internal", "external"] }] })],
      external,
    );
    expect(catalog.services[0]?.resources.map((r) => r.name)).toEqual(["orders"]);
  });

  it("omits a service whose satellite the principal may not reach", () => {
    const catalog = buildCatalog([entry()], { ...external, scopes: [] });
    expect(catalog.services).toEqual([]);
  });

  it("shows an internal caller only the external subset, not everything", () => {
    // The façade is defined by what it projects, not by who is asking. An
    // internal user calling the public API sees the public API.
    const catalog = buildCatalog(
      [
        entry(
          {},
          {
            screens: [
              { id: "orders.list", title: "Orders", audience: ["internal", "external"] },
              { id: "orders.detail", title: "Order detail", audience: ["internal"] },
            ],
          },
        ),
      ],
      internal,
    );
    expect(catalog.services[0]?.resources.map((r) => r.name)).toEqual(["orders"]);
  });

  it("drops a service with nothing left in it", () => {
    const catalog = buildCatalog(
      [
        entry(
          {},
          {
            screens: [{ id: "orders.list", title: "Orders", audience: ["internal"] }],
            actions: [],
          },
        ),
      ],
      external,
    );
    expect(catalog.services).toEqual([]);
  });
});

describe("resolving a public name back to an internal one", () => {
  it("finds the screen behind a resource", () => {
    expect(resolveResource([entry()], external, "order-management", "orders")).toMatchObject({
      satelliteId: "orders",
      screenId: "orders.list",
    });
  });

  it("finds the action behind an operation", () => {
    expect(resolveOperation([entry()], external, "order-management", "approve")).toMatchObject({
      satelliteId: "orders",
      actionId: "orders.approve",
    });
  });

  it("refuses a name that is not in this principal's catalog", () => {
    // Resolution goes through the same projection the catalog does, so a client
    // cannot reach by url what it could not see in the listing.
    expect(
      resolveResource(
        [
          entry(
            {},
            { screens: [{ id: "orders.list", title: "Orders", audience: ["internal"] }] },
          ),
        ],
        external,
        "order-management",
        "orders",
      ),
    ).toBeUndefined();
  });

  it("refuses an unknown service", () => {
    expect(resolveResource([entry()], external, "nope", "orders")).toBeUndefined();
  });

  it("does not accept the internal id in place of the public name", () => {
    // The two namespaces stay separate in both directions.
    expect(resolveResource([entry()], external, "orders", "orders.list")).toBeUndefined();
  });
});
