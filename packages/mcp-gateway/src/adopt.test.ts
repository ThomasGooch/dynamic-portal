import { SatelliteSchema } from "@portal/registry";
import { describe, expect, it } from "vitest";
import { adoptMcpTools } from "./adopt";
import type { SatelliteMcpTool } from "./client";

/**
 * The governance a satellite does not get to write for itself.
 *
 * A satellite hosting its own MCP server decides what it can *offer*. This file
 * is where the registry decides what a model may reach and on what terms — and
 * every default here leans the same way, because the failure that matters is a
 * capability becoming agent-reachable by being declared rather than by being
 * approved.
 */

const satellite = (over: Record<string, unknown> = {}) =>
  SatelliteSchema.parse({
    id: "orders",
    displayName: "Order Management",
    baseUrl: "http://localhost:4001",
    mcpUrl: "http://localhost:4001/mcp",
    owner: "team",
    rbacScopes: ["orders.read"],
    ...over,
  });

const tool = (over: Partial<SatelliteMcpTool> = {}): SatelliteMcpTool => ({
  name: "orders.search",
  title: "Search orders",
  description: "Structured search.",
  inputSchema: { type: "object", properties: { filters: { type: "object" } } },
  readOnly: true,
  ...over,
});

describe("audience", () => {
  it("starts internal, whatever the satellite's own audience is", () => {
    const { tools } = adoptMcpTools(satellite({ audience: ["internal", "external"] }), [tool()]);

    // Inheriting would make every tool on an externally-visible satellite
    // external the moment it was declared — a satellite widening its own reach
    // by shipping code, which is the one thing the registry exists to prevent.
    expect(tools[0]?.audience).toEqual(["internal"]);
  });

  it("widens only when the registry says so", () => {
    const entry = satellite({
      audience: ["internal", "external"],
      tools: { "orders.search": { audience: ["internal", "external"] } },
    });

    expect(adoptMcpTools(entry, [tool()]).tools[0]?.audience).toEqual(["internal", "external"]);
  });

  it("cannot exceed the satellite's own audience — the registry refuses to load", () => {
    // Caught earlier than this file, and worth asserting from here anyway: the
    // rule that a tool policy may not out-reach its satellite has to hold for
    // MCP tools too, and the way it holds is that the registry never loads. A
    // deployment-time failure beats a tool that quietly resolves to no audience.
    expect(() =>
      satellite({ tools: { "orders.search": { audience: ["external"] } } }),
    ).toThrow(/audience its satellite is not/);
  });

  it("drops a tool on an external-only satellite until the registry names an audience", () => {
    // The reachable way to end up with no audience at all: the default is
    // internal, the satellite is external-only, and the two do not overlap.
    // Publishing the tool anyway would be a capability that looks available and
    // refuses every caller — so it is skipped, and the skip says why.
    const externalOnly = satellite({ audience: ["external"] });
    const { tools, skipped } = adoptMcpTools(externalOnly, [tool()]);

    expect(tools).toEqual([]);
    expect(skipped[0]?.reason).toMatch(/audience/);

    // Stating it in the registry is what makes the tool exist — a person
    // deciding, in a reviewed file.
    const stated = satellite({
      audience: ["external"],
      tools: { "orders.search": { audience: ["external"] } },
    });
    expect(adoptMcpTools(stated, [tool()]).tools[0]?.audience).toEqual(["external"]);
  });
});

describe("read and write", () => {
  it("treats a tool that does not claim read-only as a write", () => {
    const { tools } = adoptMcpTools(satellite(), [tool({ name: "orders.wipe", readOnly: false })]);

    expect(tools[0]?.kind).toBe("write");
    // Both defaults follow from that, and both are the cautious direction: a
    // model does not see it, and it would pause for a person if it did.
    expect(tools[0]?.requiresConfirmation).toBe(true);
    expect(tools[0]?.agentVisible).toBe(false);
  });

  it("makes a read agent-visible without a registry entry", () => {
    // Same rule the screens follow. Requiring an entry per read would mean
    // adding a tool needed a hub deploy after all.
    const { tools } = adoptMcpTools(satellite(), [tool()]);

    expect(tools[0]?.kind).toBe("read");
    expect(tools[0]?.agentVisible).toBe(true);
    expect(tools[0]?.requiresConfirmation).toBe(false);
  });

  it("lets the registry enable a write, and the registry alone", () => {
    const entry = satellite({
      tools: {
        "orders.reconcile": {
          agentVisible: true,
          requiresConfirmation: true,
          rbacScopes: ["orders.write"],
        },
      },
    });

    const { tools } = adoptMcpTools(entry, [tool({ name: "orders.reconcile", readOnly: false })]);

    expect(tools[0]?.agentVisible).toBe(true);
    expect(tools[0]?.rbacScopes).toEqual(expect.arrayContaining(["orders.read", "orders.write"]));
  });

  it("lets the registry hide a read the satellite offers", () => {
    const entry = satellite({ tools: { "orders.search": { agentVisible: false } } });

    expect(adoptMcpTools(entry, [tool()]).tools[0]?.agentVisible).toBe(false);
  });
});

describe("the schema", () => {
  it("is carried through byte for byte", () => {
    const nested = {
      type: "object",
      properties: { filters: { type: "object", properties: { status: { type: "array" } } } },
    };

    const { tools } = adoptMcpTools(satellite(), [tool({ inputSchema: nested })]);

    // The moment this is rewritten, the gateway has an opinion about what a
    // satellite may express — and nesting is the only reason to run an MCP
    // server rather than be shimmed.
    expect(tools[0]?.inputSchema).toEqual(nested);
  });

  it("is marked as coming from MCP, so the invoker knows not to validate it", () => {
    expect(adoptMcpTools(satellite(), [tool()]).tools[0]?.source).toBe("mcp");
  });
});

describe("naming", () => {
  it("namespaces the tool by satellite", () => {
    expect(adoptMcpTools(satellite(), [tool()]).tools[0]?.name).toBe("orders__orders_search");
  });

  it("keeps the satellite's own name as the call target", () => {
    // The projected name is for the model; the satellite is called by the name
    // it published, or the round trip breaks on the first tool with a dot in it.
    expect(adoptMcpTools(satellite(), [tool()]).tools[0]?.targetId).toBe("orders.search");
  });

  it("skips a tool whose name will not fit, rather than truncating it", () => {
    const { tools, skipped } = adoptMcpTools(satellite(), [tool({ name: "x".repeat(200) })]);

    // Truncation would silently collide two long names into one tool.
    expect(tools).toEqual([]);
    expect(skipped).toHaveLength(1);
  });
});
