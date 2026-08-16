import { describe, expect, it } from "vitest";
import { MAX_TOOL_NAME_LENGTH, indexToolNames, projectToolName } from "./names";

describe("projectToolName", () => {
  it("namespaces a tool by its satellite", () => {
    // Two solutions may both have a `search`. Without the prefix the second one
    // to load silently wins, and the agent calls the wrong system.
    expect(projectToolName("orders", "search")).toBe("orders__search");
    expect(projectToolName("fleet", "search")).toBe("fleet__search");
  });

  it("replaces the dots our ids use, which MCP tool names do not allow", () => {
    // Portal ids are dotted (`orders.approve`); MCP tool names are
    // `[a-zA-Z0-9_-]`. The projection is where those two grammars meet.
    expect(projectToolName("orders", "orders.approve")).toBe("orders__orders_approve");
  });

  it("replaces every character outside the allowed set", () => {
    expect(projectToolName("a-b", "c.d_e")).toBe("a-b__c_d_e");
  });

  it("produces a name MCP will accept", () => {
    const name = projectToolName("orders", "orders.approve");
    expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(name?.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
  });

  it("refuses rather than truncating a name that will not fit", () => {
    // A truncated name is a name that collides with whatever else truncates to
    // it, and the collision surfaces as the agent calling the wrong tool.
    // Refusing loses one tool loudly instead.
    expect(projectToolName("orders", "a".repeat(MAX_TOOL_NAME_LENGTH))).toBeUndefined();
  });

  it("accepts a name that lands exactly on the limit", () => {
    const room = MAX_TOOL_NAME_LENGTH - "orders__".length;
    expect(projectToolName("orders", "a".repeat(room))).toHaveLength(MAX_TOOL_NAME_LENGTH);
  });
});

describe("indexToolNames", () => {
  const entry = (satelliteId: string, toolId: string) => ({ satelliteId, toolId });

  it("indexes each tool under its projected name", () => {
    const result = indexToolNames([entry("orders", "orders.list"), entry("fleet", "fleet.status")]);
    expect(result.collisions).toEqual([]);
    expect(result.index.get("orders__orders_list")).toEqual(entry("orders", "orders.list"));
    expect(result.index.get("fleet__fleet_status")).toEqual(entry("fleet", "fleet.status"));
  });

  it("reports two ids that project onto the same name instead of dropping one", () => {
    // `a.b` and `a_b` are different portal ids and the same MCP name. Silently
    // keeping one means an agent calling `orders__a_b` reaches a tool the
    // registry never said it could.
    const result = indexToolNames([entry("orders", "a.b"), entry("orders", "a_b")]);
    expect(result.index.has("orders__a_b")).toBe(false);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0]?.name).toBe("orders__a_b");
    expect(result.collisions[0]?.refs.map((r) => r.toolId).sort()).toEqual(["a.b", "a_b"]);
  });

  it("keeps a hyphen, which MCP allows, so `a-b` is nobody's collision", () => {
    const result = indexToolNames([entry("orders", "a.b"), entry("orders", "a-b")]);
    expect(result.collisions).toEqual([]);
    expect([...result.index.keys()].sort()).toEqual(["orders__a-b", "orders__a_b"]);
  });

  it("reports a collision between two *satellites* whose ids project alike", () => {
    // `a.b` and `a_b` are both valid satellite ids and the same namespace. This
    // is the case a collision record keyed by one satellite id cannot describe,
    // and it is the more dangerous one: the tool an agent reaches would belong
    // to a different solution entirely.
    const result = indexToolNames([entry("a.b", "run"), entry("a_b", "run")]);
    expect(result.index.size).toBe(0);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0]?.refs.map((r) => r.satelliteId).sort()).toEqual(["a.b", "a_b"]);
  });

  it("drops every colliding tool, not merely the later one", () => {
    // Keeping the first is arbitrary — which is "first" depends on the order
    // the manifests happened to load — and it is the same wrong-tool outcome
    // for whichever caller expected the other.
    // Both halves of the name are sanitized, so collisions compound: three
    // distinct satellite/tool pairs, all valid ids, all `a_b__x_y`.
    const result = indexToolNames([
      entry("a.b", "x.y"),
      entry("a.b", "x_y"),
      entry("a_b", "x.y"),
    ]);
    expect(result.index.size).toBe(0);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0]?.refs).toHaveLength(3);
  });

  it("keeps the tools that did not collide", () => {
    const result = indexToolNames([
      entry("orders", "a.b"),
      entry("orders", "a_b"),
      entry("orders", "safe"),
    ]);
    expect([...result.index.keys()]).toEqual(["orders__safe"]);
  });

  it("does not treat the same id in two satellites as a collision", () => {
    const result = indexToolNames([entry("orders", "search"), entry("fleet", "search")]);
    expect(result.collisions).toEqual([]);
    expect(result.index.size).toBe(2);
  });

  it("reports a tool whose name cannot be projected at all", () => {
    const result = indexToolNames([entry("orders", "a".repeat(200))]);
    expect(result.index.size).toBe(0);
    expect(result.unprojectable).toEqual([{ satelliteId: "orders", toolId: "a".repeat(200) }]);
  });

});

describe("the namespace separator", () => {
  // `__` was chosen because no id the registry or a manifest will accept can
  // sanitize into it: `IdSchema` alternates alphanumeric runs with *single*
  // separators. If that ever stops holding, a satellite could name a tool that
  // appears to belong to a different satellite — so it is asserted here rather
  // than assumed by the projection.
  const ID_PATTERN = /^[a-z0-9]+(?:[.\-_][a-z0-9]+)*$/;
  const VALID_IDS = ["orders", "orders.approve", "a-b", "a_b", "a.b-c_d", "x1.y2.z3"];

  it.each(VALID_IDS)("%s is a valid id that cannot produce a doubled separator", (id) => {
    expect(ID_PATTERN.test(id)).toBe(true);
    expect(projectToolName("sat", id)?.slice("sat__".length)).not.toContain("__");
  });
});
