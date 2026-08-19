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
  /** Only ever set on an expedited order; see `readDraft`. */
  expediteReason?: string;
  notes?: string;
  /**
   * What was attached, not what it contained.
   *
   * The bytes are the satellite's to store — a real one writes them to object
   * storage and keeps the key. This prototype keeps the metadata, because the
   * protocol question is whether a file can cross the hub at all, and holding
   * ten megabytes in a demo's memory answers nothing.
   */
  attachment?: { filename: string; contentType: string; bytes: number };
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
  /**
   * Absent means "leave them as they are", not "there are none".
   *
   * The form always sends this — an empty `MultiSelect` posts `[]`, so clearing
   * every label is still a change a user can make. An agent can now send it
   * too, since `ActionParamSchema` grew a `string[]` type, but the parameter is
   * not required: a caller updating one field can still leave `tags` out, and
   * reading that as `[]` would strip `hazmat` off an order as a side effect of
   * editing its customer name.
   */
  tags?: string[];
  expedited: boolean;
  expediteReason?: string;
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

/**
 * A copy nothing inside the store still points at.
 *
 * `{ ...order }` alone is not one: `tags` is an array, so the spread hands the
 * caller the store's own array and a screen builder that sorted it in place
 * would edit the record it was rendering. Cheap to get right once here, and
 * invisible until the day something mutates what it was given.
 */
const copy = (order: Order): Order => ({ ...order, tags: [...order.tags] });

export class OrderRepository {
  readonly #orders: Order[];
  /**
   * Never goes backwards, including over a delete.
   *
   * Deriving the next id from the highest one present — the obvious version —
   * reissues an id the moment its holder is removed: create `ord-1004`, delete
   * it, create again, and the new order answers to a link, a log line and an
   * audit entry that meant the old one.
   */
  #nextSequence: number;

  constructor(orders: Order[]) {
    // Copy so callers cannot mutate the seed and leak state between tests.
    this.#orders = orders.map(copy);
    this.#nextSequence =
      this.#orders
        .map((o) => Number.parseInt(o.id.replace("ord-", ""), 10))
        .filter((n) => Number.isInteger(n))
        .reduce((a, b) => Math.max(a, b), 1000) + 1;
  }

  list(tenantId: string): Order[] {
    return this.#orders.filter((o) => o.tenantId === tenantId).map(copy);
  }

  get(tenantId: string, id: string): Order | undefined {
    const found = this.#orders.find((o) => o.id === id && o.tenantId === tenantId);
    return found ? copy(found) : undefined;
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
      // Field by field rather than `...draft`: a spread writes whatever the
      // object carries, so the day a caller hands `create` something wider than
      // `OrderDraft` — a body that reached this far, a helper that grew a
      // field — `status` or `tenantId` would be set from it. The explicit list
      // is the reason the reserved fields below are actually reserved.
      customer: draft.customer,
      contactEmail: draft.contactEmail,
      total: draft.total,
      currency: draft.currency,
      dueBy: draft.dueBy,
      priority: draft.priority,
      // A create has nothing to preserve, so an absent list really is no labels.
      tags: draft.tags === undefined ? [] : [...draft.tags],
      expedited: draft.expedited,
      ...(draft.expediteReason === undefined ? {} : { expediteReason: draft.expediteReason }),
      ...(draft.notes === undefined ? {} : { notes: draft.notes }),
      id: this.#nextId(),
      tenantId,
      status: "pending",
      placedAt: new Date().toISOString(),
    };
    this.#orders.push(order);
    return copy(order);
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

    // Assigned field by field rather than `Object.assign(order, draft)`, for
    // both halves of the reason. Wide: a draft carrying `status` would write
    // it. Narrow: `notes` is optional, so an absent one leaves the previous
    // note in place and clearing the box is a change the form cannot make —
    // which on a hazmat order means the note the rules require can quietly be
    // a note the user deleted.
    order.customer = draft.customer;
    order.contactEmail = draft.contactEmail;
    order.total = draft.total;
    order.currency = draft.currency;
    order.dueBy = draft.dueBy;
    order.priority = draft.priority;
    // Absent is "unchanged", not "none" — see `OrderDraft.tags`. A caller that
    // cannot express the field must not silently erase it.
    if (draft.tags !== undefined) order.tags = [...draft.tags];
    order.expedited = draft.expedited;
    // Cleared when absent, unlike `tags`: the validator only returns this for
    // an expedited order, so absent means "this order is not expedited any
    // more" rather than "the caller could not say".
    if (draft.expediteReason === undefined) delete order.expediteReason;
    else order.expediteReason = draft.expediteReason;
    if (draft.notes === undefined) delete order.notes;
    else order.notes = draft.notes;

    return { ok: true, order: copy(order) };
  }

  /**
   * Records what was attached to an order.
   *
   * Metadata only, and deliberately so — see `Order.attachment`. A real
   * satellite writes the bytes to object storage here and keeps the key; the
   * shape of this call does not change when it does.
   */
  attach(
    tenantId: string,
    id: string,
    attachment: { filename: string; contentType: string; bytes: number },
  ): WriteResult {
    const order = this.#orders.find((o) => o.id === id && o.tenantId === tenantId);
    if (order === undefined) return { ok: false, reason: "not-found" };

    // Unlike an edit, this is allowed on a shipped order: a delivery note
    // arrives after the thing has shipped, which is the whole point of it.
    order.attachment = { ...attachment };
    return { ok: true, order: copy(order) };
  }

  /** Removes an order. Only ever a pending one. */
  remove(tenantId: string, id: string): DeleteResult {
    const index = this.#orders.findIndex((o) => o.id === id && o.tenantId === tenantId);
    // Indistinguishable from "does not exist", like every other lookup here.
    if (index < 0) return { ok: false, reason: "not-found" };

    const order = this.#orders[index]!;
    if (order.status !== "pending") return { ok: false, reason: "not-deletable" };

    this.#orders.splice(index, 1);
    return { ok: true, order: copy(order) };
  }

  /**
   * Ids are assigned here, not by the caller.
   *
   * From a counter seeded across every tenant, not from a scan of the ids still
   * present: two tenants sharing an id would make `get` ambiguous the moment
   * this store became a real table with a primary key, and a scan reissues an
   * id as soon as its holder is deleted. Reading and incrementing it is one
   * synchronous step, so two overlapping requests cannot both see the same
   * value the way an `await` between the two would let them.
   */
  #nextId(): string {
    return `ord-${this.#nextSequence++}`;
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
