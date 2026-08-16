import { ManifestSchema, type Manifest } from "@portal/protocol";
import { SatelliteSchema, type Satellite } from "@portal/registry";
import { describe, expect, it } from "vitest";
import { shimTools } from "./shim";

const satellite = (over: Record<string, unknown> = {}): Satellite =>
  SatelliteSchema.parse({
    id: "orders",
    displayName: "Order Management",
    baseUrl: "http://localhost:4001",
    owner: "fulfillment-team",
    rbacScopes: ["orders.read"],
    ...over,
  });

const manifest = (over: Record<string, unknown> = {}): Manifest =>
  ManifestSchema.parse({
    protocol: "1.1",
    satelliteId: "orders",
    displayName: "Order Management",
    screens: [{ id: "orders.list", title: "Orders", description: "Every order." }],
    actions: [],
    ...over,
  });

const find = (result: ReturnType<typeof shimTools>, name: string) =>
  result.tools.find((tool) => tool.name === name);

describe("screens become read tools", () => {
  it("projects one tool per screen", () => {
    const tool = find(shimTools(satellite(), manifest()), "orders__orders_list");
    expect(tool?.kind).toBe("read");
    expect(tool?.targetId).toBe("orders.list");
    expect(tool?.description).toContain("Every order.");
  });

  it("turns declared params into a strict object schema", () => {
    const result = shimTools(
      satellite(),
      manifest({
        screens: [
          {
            id: "orders.detail",
            title: "Order detail",
            params: [
              { name: "id", required: true, description: "Order id" },
              { name: "expand" },
            ],
          },
        ],
      }),
    );

    expect(find(result, "orders__orders_detail")?.inputSchema).toEqual({
      type: "object",
      properties: {
        // A screen param travels in a query string, so it is a string. Nothing
        // in the schema says otherwise.
        id: { type: "string", description: "Order id" },
        expand: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    });
  });

  it("gives a screen with no params an empty but callable schema", () => {
    expect(find(shimTools(satellite(), manifest()), "orders__orders_list")?.inputSchema).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });

  it("emits no schema keyword structured outputs would reject", () => {
    // The same rule the catalog follows: requiredness and enums are expressible,
    // sizes and patterns are not. One definition has to serve both the agent's
    // strict schema and an ordinary MCP client.
    const json = JSON.stringify(
      shimTools(
        satellite(),
        manifest({ screens: [{ id: "s", title: "S", params: [{ name: "q" }] }] }),
      ).tools[0]?.inputSchema,
    );
    for (const rejected of ["minLength", "maxLength", "minimum", "maximum", "pattern", "format"]) {
      expect(json).not.toContain(rejected);
    }
  });

  it("is agent-visible by default, because reading is already governed", () => {
    // A read is bounded by the same audience and scopes the screen route
    // enforces, and the satellite checks them again. Requiring a registry entry
    // per screen would also break the promise that adding a screen needs no hub
    // deploy.
    expect(find(shimTools(satellite(), manifest()), "orders__orders_list")?.agentVisible).toBe(true);
  });

  it("needs no confirmation by default", () => {
    expect(
      find(shimTools(satellite(), manifest()), "orders__orders_list")?.requiresConfirmation,
    ).toBe(false);
  });
});

describe("actions become write tools", () => {
  const withApprove = (params: unknown) =>
    manifest({
      actions: [
        { id: "orders.approve", title: "Approve order", description: "Approve it.", params },
      ],
    });

  it("projects a typed schema from the action's declared params", () => {
    const result = shimTools(satellite(), withApprove([
      { name: "id", type: "string", required: true },
      { name: "quantity", type: "number" },
      { name: "notify", type: "boolean" },
      { name: "reason", type: "string", enum: ["late", "fraud"] },
    ]));

    expect(find(result, "orders__orders_approve")?.inputSchema).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        quantity: { type: "number" },
        notify: { type: "boolean" },
        reason: { type: "string", enum: ["late", "fraud"] },
      },
      required: ["id"],
      additionalProperties: false,
    });
  });

  it("is invisible to the agent by default, unlike a read", () => {
    // Exposing a *write* to a model is a governance decision, so it is made in
    // the registry — the file a human reviews — rather than inherited from a
    // satellite adding an endpoint. This is the one place the zero-hub-deploy
    // rule deliberately does not apply.
    expect(
      find(shimTools(satellite(), withApprove([{ name: "id", type: "string" }])), "orders__orders_approve")
        ?.agentVisible,
    ).toBe(false);
  });

  it("becomes visible when the registry says so", () => {
    const sat = satellite({ tools: { "orders.approve": { agentVisible: true } } });
    const tool = find(
      shimTools(sat, withApprove([{ name: "id", type: "string" }])),
      "orders__orders_approve",
    );
    expect(tool?.agentVisible).toBe(true);
  });

  it("requires confirmation by default", () => {
    expect(
      find(shimTools(satellite(), withApprove([{ name: "id", type: "string" }])), "orders__orders_approve")
        ?.requiresConfirmation,
    ).toBe(true);
  });

  it("cannot have confirmation turned off by a satellite, only by the registry", () => {
    // The manifest is the satellite's file. If a satellite could clear the
    // confirmation flag on its own write, the governance would be advisory.
    const sat = satellite({ tools: { "orders.approve": { requiresConfirmation: false } } });
    expect(
      find(shimTools(sat, withApprove([{ name: "id", type: "string" }])), "orders__orders_approve")
        ?.requiresConfirmation,
    ).toBe(false);
  });

  it("skips an action that never says what it takes", () => {
    // Not a silent omission: an agent that cannot see the shape would guess
    // field names at a write endpoint, which is the worst available outcome.
    const result = shimTools(satellite(), withApprove(undefined));
    expect(find(result, "orders__orders_approve")).toBeUndefined();
    expect(result.skipped).toEqual([
      { toolId: "orders.approve", reason: "action declares no parameters, so no agent can call it" },
    ]);
  });

  it("keeps an action that declares an empty parameter list", () => {
    // Different from declaring nothing: "this takes no arguments" is a
    // statement, and a callable one.
    const result = shimTools(satellite(), withApprove([]));
    expect(find(result, "orders__orders_approve")?.inputSchema).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });
});

describe("authorization carried onto the tool", () => {
  it("unions the satellite's scopes with the tool's own", () => {
    // Union, not override: a tool policy adds a requirement, it does not
    // relieve the caller of the satellite's.
    const sat = satellite({ tools: { "orders.approve": { rbacScopes: ["orders.write"] } } });
    const tool = find(
      shimTools(
        sat,
        manifest({ actions: [{ id: "orders.approve", params: [{ name: "id", type: "string" }] }] }),
      ),
      "orders__orders_approve",
    );
    expect([...(tool?.rbacScopes ?? [])].sort()).toEqual(["orders.read", "orders.write"]);
  });

  it("takes the narrower of the manifest's audience and the registry's", () => {
    // The registry is the governance file, and its silence means internal —
    // so listing a tool at all pins it to internal unless the entry widens it.
    const sat = satellite({
      audience: ["internal", "external"],
      tools: { "orders.approve": { agentVisible: true } },
    });
    const tool = find(
      shimTools(
        sat,
        manifest({
          audience: ["internal", "external"],
          actions: [
            {
              id: "orders.approve",
              audience: ["internal", "external"],
              params: [{ name: "id", type: "string" }],
            },
          ],
        }),
      ),
      "orders__orders_approve",
    );
    expect(tool?.audience).toEqual(["internal"]);
  });

  it("leaves an unlisted tool's audience as the manifest declared it", () => {
    const sat = satellite({ audience: ["internal", "external"] });
    const tool = find(
      shimTools(
        sat,
        manifest({
          audience: ["internal", "external"],
          screens: [{ id: "orders.list", title: "Orders", audience: ["internal", "external"] }],
        }),
      ),
      "orders__orders_list",
    );
    expect(tool?.audience).toEqual(["internal", "external"]);
  });

  it("never widens past the satellite's own audience, listed or not", () => {
    // The hub's screen and action routes gate on the satellite's entry before
    // they look at what a screen declares. A gateway that only read the screen
    // would hand an internal-only satellite's externally-declared screen to an
    // external principal — the registry's audience, silently overridden by the
    // satellite team that wrote the manifest.
    const tool = find(
      shimTools(
        satellite(),
        manifest({
          audience: ["internal", "external"],
          screens: [{ id: "orders.list", title: "Orders", audience: ["external"] }],
        }),
      ),
      "orders__orders_list",
    );
    expect(tool).toBeUndefined();
  });

  it("does not read a tool policy off Object.prototype", () => {
    // `constructor` is a legal id, and `tools` is a plain object: looked up
    // with `in` it resolves to `Object`, and the audience narrowing then reads
    // `.audience` off a function.
    const result = shimTools(
      satellite(),
      manifest({ screens: [{ id: "constructor", title: "C" }] }),
    );
    expect(find(result, "orders__constructor")?.audience).toEqual(["internal"]);
  });
});

describe("names that cannot be projected", () => {
  it("skips a screen whose id is too long to become a tool name", () => {
    const long = `orders.${"a".repeat(80)}`;
    const result = shimTools(satellite(), manifest({ screens: [{ id: long, title: "Long" }] }));
    expect(result.tools).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/tool name/i);
  });

  it("drops both halves of a collision rather than picking one", () => {
    const result = shimTools(
      satellite(),
      manifest({
        screens: [
          { id: "a.b", title: "Dotted" },
          { id: "a_b", title: "Underscored" },
        ],
      }),
    );
    expect(result.tools).toEqual([]);
    expect(result.skipped.map((s) => s.toolId).sort()).toEqual(["a.b", "a_b"]);
  });
});
