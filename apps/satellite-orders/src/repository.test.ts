import { describe, expect, it } from "vitest";
import { OrderRepository, seedOrders } from "./repository";

const repo = () => new OrderRepository(seedOrders());

describe("OrderRepository tenant scoping", () => {
  it("lists only the calling tenant's orders", () => {
    const acme = repo().list("acme");
    expect(acme.length).toBeGreaterThan(0);
    expect(acme.every((o) => o.tenantId === "acme")).toBe(true);
  });

  it("gives different tenants disjoint result sets", () => {
    const r = repo();
    const acmeIds = new Set(r.list("acme").map((o) => o.id));
    const globexIds = r.list("globex").map((o) => o.id);
    expect(globexIds.length).toBeGreaterThan(0);
    expect(globexIds.some((id) => acmeIds.has(id))).toBe(false);
  });

  // Returning undefined rather than the record — and, at the HTTP layer, 404
  // rather than 403 — matters: a 403 would confirm that someone else's order id
  // exists, which is itself a disclosure.
  it("does not return another tenant's order by id", () => {
    const r = repo();
    const foreign = r.list("globex")[0];
    expect(foreign).toBeDefined();
    expect(r.get("acme", foreign!.id)).toBeUndefined();
  });

  it("returns the tenant's own order by id", () => {
    const r = repo();
    const own = r.list("acme")[0]!;
    expect(r.get("acme", own.id)?.id).toBe(own.id);
  });

  it("refuses to approve another tenant's order", () => {
    const r = repo();
    const foreign = r.list("globex")[0]!;
    expect(r.approve("acme", foreign.id)).toEqual({ ok: false, reason: "not-found" });
    expect(r.get("globex", foreign.id)?.status).not.toBe("approved");
  });

  it("approves the tenant's own pending order", () => {
    const r = repo();
    const pending = r.list("acme").find((o) => o.status === "pending")!;
    expect(pending).toBeDefined();
    expect(r.approve("acme", pending.id)).toEqual({ ok: true });
    expect(r.get("acme", pending.id)?.status).toBe("approved");
  });

  it("reports a domain refusal when the order is not pending", () => {
    const r = repo();
    const pending = r.list("acme").find((o) => o.status === "pending")!;
    r.approve("acme", pending.id);
    expect(r.approve("acme", pending.id)).toEqual({
      ok: false,
      reason: "not-pending",
    });
  });

  it("isolates instances so tests cannot leak state into one another", () => {
    const a = repo();
    const pending = a.list("acme").find((o) => o.status === "pending")!;
    a.approve("acme", pending.id);
    expect(repo().get("acme", pending.id)?.status).toBe("pending");
  });
});


describe("every field of a draft reaches the record", () => {
  // Create and update copy field by field rather than spreading, so that an
  // absent optional is cleared rather than left behind. The cost is that a new
  // field has to be added in two more places — and it was not, the first time.
  // This is the guard for the next one.
  it("stores every key a draft can carry", () => {
    const repository = new OrderRepository(seedOrders());
    const draft = {
      customer: "Every Field Ltd",
      contactEmail: "every@field.test",
      total: 12.5,
      currency: "USD",
      dueBy: "2027-01-01",
      priority: "critical" as const,
      tags: ["retail"],
      expedited: true,
      expediteReason: "signed off",
      notes: "handle with care",
    };

    const created = repository.create("acme", draft);
    for (const [key, value] of Object.entries(draft)) {
      expect(created[key as keyof typeof created], `create dropped ${key}`).toEqual(value);
    }

    const changed = { ...draft, customer: "Changed Ltd", expediteReason: "re-approved" };
    const updated = repository.update("acme", created.id, changed);
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    for (const [key, value] of Object.entries(changed)) {
      expect(updated.order[key as keyof typeof updated.order], `update dropped ${key}`).toEqual(value);
    }
  });
});
