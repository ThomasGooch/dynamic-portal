import { describe, expect, it } from "vitest";
import { nestedToKeyed, validateNested } from "@portal/catalog";
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
