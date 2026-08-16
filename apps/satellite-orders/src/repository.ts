/**
 * In-memory order store, scoped by tenant at every entry point.
 *
 * Every read and write takes `tenantId` as its first argument rather than
 * filtering afterwards, so "forgot to scope" is a type error at the call site
 * instead of a silent disclosure. A real satellite would push the predicate
 * into SQL; the shape of the interface is the part worth copying.
 */

export type OrderStatus = "pending" | "approved" | "shipped" | "cancelled";

export interface Order {
  id: string;
  tenantId: string;
  customer: string;
  total: number;
  currency: string;
  status: OrderStatus;
  placedAt: string;
  blockedByVehicleId?: string;
}

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
      status: "shipped",
      placedAt: "2026-08-11T14:02:00Z",
    },
    {
      id: "ord-1003",
      tenantId: "acme",
      customer: "Acme Anvils Division",
      total: 1240.0,
      currency: "USD",
      status: "pending",
      placedAt: "2026-08-12T08:30:00Z",
    },
    {
      id: "ord-2001",
      tenantId: "globex",
      customer: "Globex Retail",
      total: 61.25,
      currency: "USD",
      status: "pending",
      placedAt: "2026-08-09T16:45:00Z",
    },
    {
      id: "ord-2002",
      tenantId: "globex",
      customer: "Globex Wholesale",
      total: 5400.0,
      currency: "USD",
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
