import { describe, expect, it } from "vitest";
import { nestedToKeyed, validateNested } from "@portal/catalog";
import { extractData } from "@portal/mcp-gateway";
import { detailScreen, listScreen, manifest, ordersTable } from "./screens";
import { seedOrders, type Order } from "./repository";

const orders: Order[] = seedOrders().filter((o) => o.tenantId === "acme");

/**
 * The catalog is only useful if it accepts what satellites actually emit.
 *
 * A vocabulary that validates its own examples and rejects real screens is
 * worse than none — it fails at the trust boundary, in production, for the one
 * team that adopted it. These tests run the real screen builders through the
 * real catalog, so a component or prop drifting apart from the vocabulary is a
 * failing build here rather than a 500 in the hub later.
 */
describe("screens conform to the catalog", () => {
  const screens = [
    ["orders.list", listScreen(orders).ui],
    ["orders.detail", detailScreen(orders[0]!).ui],
    ["orders.list (empty)", listScreen([]).ui],
    // The role variants go through the same gate. A chart or table added for
    // one role is exactly as able to name a prop the catalog rejects as any
    // other node, and it would fail in the hub for that role only — the
    // hardest kind of break to reproduce.
    ["orders.list (finance)", listScreen(orders, "internal", ["finance"]).ui],
    ["orders.list (platform)", listScreen(orders, "internal", ["platform"]).ui],
    ["orders.list (engineering)", listScreen(orders, "internal", ["engineering"]).ui],
    [
      "orders.list (every role)",
      listScreen(orders, "internal", ["finance", "platform", "engineering"]).ui,
    ],
    ["orders.list (every role, empty)", listScreen([], "internal", ["finance", "platform", "engineering"]).ui],
  ] as const;

  it.each(screens)("%s validates", (_label, ui) => {
    const result = validateNested(ui);
    if (!result.ok) {
      // Surface the actual issue rather than a bare "expected true".
      throw new Error(
        result.issues.map((i) => `${i.path}: ${i.message}`).join("\n"),
      );
    }
    expect(result.ok).toBe(true);
  });

  it("the action patch payload validates too", () => {
    // A patch carries a subtree, so it crosses the same boundary as a screen
    // and has to satisfy the same vocabulary.
    expect(validateNested(ordersTable(orders)).ok).toBe(true);
  });

  it("converts to the renderer's keyed shape without loss of ids", () => {
    const keyed = nestedToKeyed(listScreen(orders).ui);
    expect(Object.keys(keyed.elements)).toContain("orders-table");
  });
});

/**
 * Role sections add to the screen; they never take anything off it.
 *
 * The satellite is where this decision lives rather than the hub: a hub filter
 * would mean the figures had already crossed the wire to be discarded, and a
 * number nobody was entitled to is not made safe by not drawing it.
 */
describe("role sections", () => {
  const idsFor = (roles: readonly string[]): string[] =>
    Object.keys(nestedToKeyed(listScreen(orders, "internal", roles).ui).elements);

  it("gives each role its own section and nobody else's", () => {
    const owned = {
      finance: "orders-finance-chart",
      platform: "orders-platform-metrics",
      engineering: "orders-work-queue",
    } as const;

    for (const [role, nodeId] of Object.entries(owned)) {
      expect(idsFor([role])).toContain(nodeId);
      for (const other of ["finance", "platform", "engineering", "leadership"]) {
        if (other === role) continue;
        expect(idsFor([other])).not.toContain(nodeId);
      }
    }
  });

  it("leaves the shared screen intact for every role, and for none", () => {
    // The regression that would matter: someone turning an addition into a
    // replacement, so a role gains a section and silently loses the table.
    for (const roles of [
      [],
      ["finance"],
      ["platform"],
      ["engineering"],
      ["finance", "platform", "engineering"],
    ]) {
      expect(idsFor(roles), `lost for ${JSON.stringify(roles)}`).toContain("orders-table");
    }
  });

  it("holding no role is not the same as being refused", () => {
    // A principal with no roles sees the shared screen and none of the
    // additions. Asserted against literal ids, not against `listScreen(orders)`
    // — that call has the same defaults, so comparing them was comparing a
    // thing to itself and could not fail.
    const ids = idsFor([]);
    expect(ids).toContain("orders-table");
    for (const roleOwned of [
      "orders-finance-chart",
      "orders-platform-metrics",
      "orders-work-queue",
    ]) {
      expect(ids).not.toContain(roleOwned);
    }
  });

  it("gives an external principal no role sections, whatever it claims", () => {
    // `authorize` skips the role check for external principals — org roles
    // describe internal staff. This must agree, or the public façade projects
    // the work queue's priority and dueBy to a partner as a second collection.
    const external = Object.keys(
      nestedToKeyed(listScreen(orders, "external", ["finance", "platform", "engineering"]).ui)
        .elements,
    );
    expect(external).toContain("orders-table");
    for (const roleOwned of [
      "orders-finance-chart",
      "orders-platform-metrics",
      "orders-work-queue",
    ]) {
      expect(external).not.toContain(roleOwned);
    }
  });

  it("does not change the figures the front page headlines", () => {
    // The hub's overview takes the first four StatTiles off this screen and
    // headlines them on the solution card. Role sections must not reach that
    // set, or the card shows different numbers to different people — which is
    // what happened: a platform principal saw "Currencies" as the fourth
    // figure on the Orders card while everyone else saw three.
    const headline = (roles: readonly string[]): string[] =>
      extractData(listScreen(orders, "internal", roles).ui)
        .stats.slice(0, 4)
        .map((stat) => stat.label);

    const shared = headline([]);
    for (const roles of [["finance"], ["platform"], ["engineering"], ["finance", "platform", "engineering"]]) {
      expect(headline(roles), `headline moved for ${JSON.stringify(roles)}`).toEqual(shared);
    }
  });

  it("holding every role gets every section", () => {
    const ids = idsFor(["finance", "platform", "engineering"]);
    expect(ids).toEqual(
      expect.arrayContaining(["orders-table", "orders-finance-chart", "orders-work-queue"]),
    );
  });

  it("an unknown role adds nothing", () => {
    // Roles arrive from an IdP. One the satellite does not know must be inert
    // rather than a reason to draw something or to fail.
    expect(idsFor(["auditor"])).toEqual(idsFor([]));
  });
});

describe("every write names the role that may make it", () => {
  // The regression this guards: the satellite used to declare a satellite-level
  // `roles` ceiling, and each action inherited it. Removing that ceiling — so
  // every role can SEE the satellite — silently un-gated every action that
  // declared none of its own. A write with no `roles` is now open to all four
  // org roles, which for orders.delete meant a platform principal could delete
  // an order it could not previously even look at.
  const WRITES: Record<string, readonly string[]> = {
    "orders.create": ["engineering"],
    "orders.update": ["engineering"],
    "orders.attach": ["engineering"],
    "orders.delete": ["leadership"],
    "orders.approve": ["leadership", "finance"],
  };

  it.each(Object.entries(WRITES))("%s is gated to %s", (id, expected) => {
    const action = manifest().actions?.find((candidate) => candidate.id === id);
    expect(action, `${id} is not declared`).toBeDefined();
    expect(action?.roles, `${id} declares no roles, so every role may call it`).toEqual(expected);
  });

  it("leaves no write un-gated", () => {
    // Catches a write ADDED later without a role, which the table above would
    // not: a new action nobody listed simply would not be checked.
    const reads = new Set(["orders.refresh"]);
    for (const action of manifest().actions ?? []) {
      if (reads.has(action.id)) continue;
      expect(action.roles, `${action.id} is a write with no role gate`).toBeDefined();
    }
  });
});

describe("manifest", () => {
  it("declares every screen the app can actually serve", () => {
    // Drift here means a nav entry that 404s at click time.
    const declared = manifest().screens.map((s) => s.id);
    expect(declared).toEqual(expect.arrayContaining(["orders.list", "orders.detail"]));
  });

  it("publishes exactly the two screens a customer may read, and nothing else", () => {
    // The satellite's half of the bargain. The registry may name whatever it
    // likes publicly; nothing is reachable until this file agrees. Pinned to an
    // exact list so widening it is a deliberate change to this test, not a side
    // effect of editing the one beside it.
    const declared = manifest();
    expect(declared.audience).toEqual(["internal", "external"]);

    const external = declared.screens
      .filter((screen) => screen.audience.includes("external"))
      .map((screen) => screen.id);
    expect(external).toEqual(["orders.list", "orders.detail"]);
  });

  it("keeps every action internal, including the one the registry could publish", () => {
    // Approving an order is staff work. A customer reading their own orders is
    // not the same permission, and the audience model is where that is said.
    for (const action of manifest().actions) {
      expect(action.audience, action.id).toEqual(["internal"]);
    }
  });
});
