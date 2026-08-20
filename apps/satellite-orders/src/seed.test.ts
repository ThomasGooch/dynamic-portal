import { describe, expect, it } from "vitest";
import { seedOrders } from "./repository";

/**
 * The demo data stays obviously invented.
 *
 * This portal gets shown to people, under a real organisation's branding, in
 * an industry where a screenshot of plausible-looking personal data is a
 * problem regardless of whether the data is real. Wile E. Coyote is not
 * anyone; a name that merely *looks* fictional is a judgement call somebody
 * has to make again every time the seed is edited.
 *
 * So it is asserted rather than intended. The cost of getting this wrong is
 * not a failing test — it is a screenshot in a deck.
 */

const FICTIONAL = [
  "Wile E. Coyote",
  "Road Runner Logistics",
  "Acme Anvils Division",
  "Globex Retail",
  "Globex Wholesale",
];

/**
 * `.test` is reserved by RFC 6761 and can never resolve, so an address here
 * cannot reach a person even by accident — unlike a plausible-looking address
 * at a domain somebody owns.
 */
const RESERVED = /@[a-z0-9.-]+\.(test|example|invalid|localhost)$/i;

/**
 * Every address in the record, not just the one in `contactEmail`.
 *
 * Checking that field alone left the free-text ones — `notes`,
 * `expediteReason`, an attachment filename — able to carry
 * `jane.whitfield@acmecorp.com` past all four assertions here, which is the
 * same screenshot with an extra step.
 */
const ADDRESSES = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

describe("the seed data", () => {
  const orders = seedOrders();

  it("has orders to check", () => {
    // Guards the guard: an empty seed would satisfy every `every` below.
    expect(orders.length).toBeGreaterThan(3);
  });

  it("names only invented customers", () => {
    for (const order of orders) {
      expect(FICTIONAL, `"${order.customer}" is not one of the invented names`).toContain(
        order.customer,
      );
    }
  });

  it("uses addresses that cannot reach anybody", () => {
    for (const order of orders) {
      const found = JSON.stringify(order).match(ADDRESSES) ?? [];
      // Guards the guard: an order that stopped carrying an address at all —
      // or a pattern that stopped finding one — would otherwise pass on an
      // empty list.
      expect(found, `${order.id} carries no address for this to check`).not.toHaveLength(0);
      for (const address of found) {
        expect(address, `${address} is not on a reserved domain`).toMatch(RESERVED);
      }
    }
  });

  it("carries no field that reads as personal or clinical data", () => {
    // Not a scanner — a list of the shapes that would be wrong here if someone
    // reached for realism while filling in a demo.
    const forbidden = /\b(ssn|nhs|dob|dateOfBirth|patient|diagnosis|prescription|medication|nric|insurance)\b/i;
    for (const order of orders) {
      expect(JSON.stringify(order)).not.toMatch(forbidden);
    }
  });
});
