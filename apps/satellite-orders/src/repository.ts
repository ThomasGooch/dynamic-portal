/**
 * In-memory order store, scoped by tenant at every entry point.
 *
 * Every read and write takes `tenantId` as its first argument rather than
 * filtering afterwards, so "forgot to scope" is a type error at the call site
 * instead of a silent disclosure. A real satellite would push the predicate
 * into SQL; the shape of the interface is the part worth copying.
 */

export type OrderStatus = "pending" | "approved" | "shipped" | "cancelled";

export type Priority = "standard" | "express" | "critical";

export interface Order {
  id: string;
  tenantId: string;
  customer: string;
  /** Where the confirmation goes. Validated for shape, not deliverability. */
  contactEmail: string;
  total: number;
  currency: string;
  status: OrderStatus;
  placedAt: string;
  /** ISO date, no time: the form renders a `DateField`, which has no clock. */
  dueBy: string;
  priority: Priority;
  /** Free-form labels, chosen from a fixed list — a `MultiSelect` on the form. */
  tags: string[];
  expedited: boolean;
  notes?: string;
  blockedByVehicleId?: string;
}

/** What a create or update supplies. `id`, `tenantId` and `status` are ours. */
export interface OrderDraft {
  customer: string;
  contactEmail: string;
  total: number;
  currency: string;
  dueBy: string;
  priority: Priority;
  tags: string[];
  expedited: boolean;
  notes?: string;
}

export type WriteResult =
  | { ok: true; order: Order }
  | { ok: false; reason: "not-found" | "not-editable" };

export type DeleteResult =
  | { ok: true; order: Order }
  | { ok: false; reason: "not-found" | "not-deletable" };

export type ApproveResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "not-pending" };

export function seedOrders(): Order[] {
  return [
    {
      id: "ord-1001",
      tenantId: "acme",
      customer: "Wile E. Coyote",
      total: 429.99,
      currency: "USD",
      contactEmail: "ord-1001@example.test",
      dueBy: "2026-09-03",
      priority: "critical",
      tags: [],
      expedited: true,
      status: "pending",
      placedAt: "2026-08-10T09:14:00Z",
      blockedByVehicleId: "veh-77",
    },
    {
      id: "ord-1002",
      tenantId: "acme",
      customer: "Road Runner Logistics",
      total: 88.5,
      currency: "USD",
      contactEmail: "ord-1002@example.test",
      dueBy: "2026-09-04",
      priority: "standard",
      tags: ["retail"],
      expedited: false,
      status: "shipped",
      placedAt: "2026-08-11T14:02:00Z",
    },
    {
      id: "ord-1003",
      tenantId: "acme",
      customer: "Acme Anvils Division",
      total: 1240.0,
      currency: "USD",
      contactEmail: "ord-1003@example.test",
      dueBy: "2026-09-05",
      priority: "express",
      tags: ["wholesale", "priority"],
      expedited: false,
      status: "pending",
      placedAt: "2026-08-12T08:30:00Z",
    },
    {
      id: "ord-2001",
      tenantId: "globex",
      customer: "Globex Retail",
      total: 61.25,
      currency: "USD",
      contactEmail: "ord-2001@example.test",
      dueBy: "2026-09-04",
      priority: "standard",
      tags: ["retail"],
      expedited: false,
      status: "pending",
      placedAt: "2026-08-09T16:45:00Z",
    },
    {
      id: "ord-2002",
      tenantId: "globex",
      customer: "Globex Wholesale",
      total: 5400.0,
      currency: "USD",
      contactEmail: "ord-2002@example.test",
      dueBy: "2026-09-05",
      priority: "express",
      tags: ["wholesale", "priority"],
      expedited: false,
      status: "approved",
      placedAt: "2026-08-13T11:20:00Z",
      blockedByVehicleId: "veh-12",
    },
  ];
}

export class OrderRepository {
  readonly #orders: Order[];

  constructor(orders: Order[]) {
    // Copy so callers cannot mutate the seed and leak state between tests.
    this.#orders = orders.map((o) => ({ ...o }));
  }

  list(tenantId: string): Order[] {
    return this.#orders.filter((o) => o.tenantId === tenantId).map((o) => ({ ...o }));
  }

  get(tenantId: string, id: string): Order | undefined {
    const found = this.#orders.find((o) => o.id === id && o.tenantId === tenantId);
    return found ? { ...found } : undefined;
  }

  /**
   * Creates an order for this tenant.
   *
   * The tenant comes from the verified principal, never from the draft — a
   * create that let the caller name its own tenant would be a cross-tenant
   * write with extra steps.
   */
  create(tenantId: string, draft: OrderDraft): Order {
    const order: Order = {
      ...draft,
      id: this.#nextId(),
      tenantId,
      status: "pending",
      placedAt: new Date().toISOString(),
    };
    this.#orders.push({ ...order });
    return { ...order };
  }

  /**
   * Replaces the editable fields of an existing order.
   *
   * `status`, `placedAt` and `tenantId` are not among them: they are the
   * satellite's to set, and a form that could rewrite them would let a user
   * approve an order by editing it.
   */
  update(tenantId: string, id: string, draft: OrderDraft): WriteResult {
    const order = this.#orders.find((o) => o.id === id && o.tenantId === tenantId);
    if (!order) return { ok: false, reason: "not-found" };
    // Shipped orders have left; editing one would describe something that is
    // no longer true rather than change anything.
    if (order.status === "shipped" || order.status === "cancelled") {
      return { ok: false, reason: "not-editable" };
    }

    Object.assign(order, draft);
    return { ok: true, order: { ...order } };
  }

  /** Removes an order. Only ever a pending one. */
  remove(tenantId: string, id: string): DeleteResult {
    const index = this.#orders.findIndex((o) => o.id === id && o.tenantId === tenantId);
    // Indistinguishable from "does not exist", like every other lookup here.
    if (index < 0) return { ok: false, reason: "not-found" };

    const order = this.#orders[index]!;
    if (order.status !== "pending") return { ok: false, reason: "not-deletable" };

    this.#orders.splice(index, 1);
    return { ok: true, order: { ...order } };
  }

  /**
   * Ids are assigned here, not by the caller.
   *
   * Scanning every tenant rather than just this one: two tenants sharing an id
   * would make `get` ambiguous the moment this store became a real table with a
   * primary key.
   */
  #nextId(): string {
    const highest = this.#orders
      .map((o) => Number.parseInt(o.id.replace("ord-", ""), 10))
      .filter((n) => Number.isFinite(n))
      .reduce((a, b) => Math.max(a, b), 1000);
    return `ord-${highest + 1}`;
  }

  approve(tenantId: string, id: string): ApproveResult {
    const order = this.#orders.find((o) => o.id === id && o.tenantId === tenantId);
    // Deliberately indistinguishable from "does not exist": a caller must not be
    // able to probe for another tenant's order ids.
    if (!order) return { ok: false, reason: "not-found" };
    if (order.status !== "pending") return { ok: false, reason: "not-pending" };
    order.status = "approved";
    return { ok: true };
  }
}
