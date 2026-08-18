import type { Audience, Manifest, ScreenResponse, UiNode } from "@portal/protocol";
import { manifest as declare, screen, ui, withId } from "@portal/sdk-node";
import type { Order } from "./repository";
import { CURRENCIES, PRIORITIES, TAGS } from "./draft";

/**
 * The satellite's declaration and its screens.
 *
 * Note what is absent: any styling. The satellite says "this is a Table with
 * these columns" and "this Badge has tone danger"; how a danger badge looks is
 * the hub's business. That is the whole bargain.
 *
 * Written through `@portal/sdk-node` rather than as object literals. The
 * difference is where a mistake surfaces: `ui.Text({ txt: … })` does not
 * compile, and a `tone` the catalog does not have throws on this line instead
 * of arriving at the hub as a screen it refuses whole.
 */

const money = (order: Order): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: order.currency }).format(
    order.total,
  );

const statusTone = (status: Order["status"]) =>
  ({ pending: "warning", approved: "success", shipped: "info", cancelled: "danger" })[
    status
  ] as "warning" | "success" | "info" | "danger";

/** Rows are shaped for display — tenantId never crosses the wire. */
function toRow(order: Order): Record<string, unknown> {
  return {
    id: order.id,
    customer: order.customer,
    total: money(order),
    status: order.status,
    statusTone: statusTone(order.status),
    placedAt: order.placedAt,
  };
}

export function manifest(): Manifest {
  return declare({
    satelliteId: "orders",
    displayName: "Order Management",
    description: "Track, review, and approve customer orders.",
    // Widened deliberately, and only this far. A customer may read their own
    // orders; approving one stays internal. Tenant scoping does the rest — an
    // external principal is scoped by the same `tenantId` an internal one is,
    // and this satellite checks it on every call rather than trusting the hub.
    audience: ["internal", "external"],
    screens: [
      {
        id: "orders.list",
        title: "Orders",
        description: "All orders for the current tenant.",
        audience: ["internal", "external"],
      },
      {
        id: "orders.detail",
        title: "Order detail",
        params: [{ name: "id", required: true, description: "Order id" }],
        audience: ["internal", "external"],
      },
      // The two form screens stay internal. A customer may read their own
      // orders through the façade; placing and editing them is staff work.
      { id: "orders.new", title: "New order", audience: ["internal"] },
      {
        id: "orders.edit",
        title: "Edit order",
        params: [{ name: "id", required: true, description: "Order id" }],
        audience: ["internal"],
      },
    ],
    actions: [
      {
        id: "orders.approve",
        title: "Approve order",
        description: "Move a pending order to approved.",
        // Declared so the MCP gateway can describe this write to an agent. An
        // action that says nothing about its inputs stays uncallable by one,
        // which is better than a model guessing field names at a write.
        params: [
          { name: "id", type: "string", required: true, description: "The order id to approve." },
        ],
        audience: ["internal"],
      },
      {
        // Declared in full so the gateway can describe it to an agent. Every
        // field the form carries appears here, because a write an agent can
        // only half-specify is a write it will get wrong.
        id: "orders.create",
        title: "Create order",
        description: "Place a new order for this tenant.",
        params: [
          { name: "customer", type: "string", required: true, description: "Who the order is for." },
          { name: "contactEmail", type: "string", required: true, description: "Where the confirmation goes." },
          { name: "total", type: "number", required: true, description: "Order total, above zero." },
          {
            name: "currency",
            type: "string",
            required: true,
            description: "Currency code.",
            enum: [...CURRENCIES],
          },
          { name: "dueBy", type: "string", required: true, description: "Due date, YYYY-MM-DD, not in the past." },
          {
            name: "priority",
            type: "string",
            required: true,
            description: "Standard, express or critical. Critical orders must be expedited.",
            enum: [...PRIORITIES],
          },
          { name: "expedited", type: "boolean", description: "Expedite. Required for critical priority." },
          { name: "notes", type: "string", description: "Handling notes. Required when labelled hazmat." },
        ],
        audience: ["internal"],
      },
      {
        id: "orders.update",
        title: "Update order",
        description: "Change a pending or approved order.",
        params: [
          { name: "id", type: "string", required: true, description: "The order to change." },
          { name: "customer", type: "string", required: true, description: "Who the order is for." },
          { name: "contactEmail", type: "string", required: true, description: "Where the confirmation goes." },
          { name: "total", type: "number", required: true, description: "Order total, above zero." },
          { name: "currency", type: "string", required: true, description: "Currency code.", enum: [...CURRENCIES] },
          { name: "dueBy", type: "string", required: true, description: "Due date, YYYY-MM-DD, not in the past." },
          {
            name: "priority",
            type: "string",
            required: true,
            description: "Standard, express or critical.",
            enum: [...PRIORITIES],
          },
          { name: "expedited", type: "boolean", description: "Expedite. Required for critical priority." },
          { name: "notes", type: "string", description: "Handling notes." },
        ],
        audience: ["internal"],
      },
      {
        id: "orders.delete",
        title: "Delete order",
        description: "Remove a pending order. Only pending orders can be removed.",
        params: [
          { name: "id", type: "string", required: true, description: "The order to remove." },
        ],
        audience: ["internal"],
      },
      {
        id: "orders.refresh",
        title: "Refresh orders",
        description: "Re-read the order table without leaving the screen.",
        params: [],
        audience: ["internal"],
      },
    ],
    nav: [{ screenId: "orders.list", label: "Orders", section: "Operations", order: 10 }],
    healthPath: "/healthz",
  });
}

export function ordersTable(orders: Order[]): UiNode {
  return withId(
    "orders-table",
    ui.Table({
      columns: [
        { key: "id", label: "Order" },
        { key: "customer", label: "Customer" },
        { key: "total", label: "Total", align: "end" },
        { key: "status", label: "Status", as: "badge", toneKey: "statusTone" },
        { key: "placedAt", label: "Placed", as: "date" },
      ],
      rows: orders.map(toRow),
      rowAction: { screenId: "orders.detail", paramKey: "id" },
      emptyMessage: "No orders yet.",
    }),
  );
}

/**
 * Whether to draw the controls that write.
 *
 * An external principal reads its own orders through the façade and may not
 * place or change them: every write action here declares `audience:
 * ["internal"]`, so the satellite answers 403. Drawing the buttons anyway
 * offers a customer three things that fail when clicked — the authorization
 * was never wrong, the screen was.
 */
const canWrite = (audience: Audience): boolean => audience === "internal";

export function listScreen(orders: Order[], audience: Audience = "internal"): ScreenResponse {
  const pending = orders.filter((order) => order.status === "pending").length;
  const blocked = orders.filter((order) => order.blockedByVehicleId).length;

  return screen({
    id: "orders.list",
    title: "Orders",
    ttlSeconds: 15,
    ui: ui.Page(
      {},
      ui.Grid(
        { columns: 3 },
        ui.StatTile({ label: "Total orders", value: String(orders.length) }),
        ui.StatTile({ label: "Pending", value: String(pending), tone: "warning" }),
        ui.StatTile({
          label: "Blocked",
          value: String(blocked),
          tone: blocked > 0 ? "danger" : "muted",
        }),
      ),
      ui.Section(
        { title: "All orders" },
        ordersTable(orders),
        ui.Stack(
          { direction: "row", gap: "sm", align: "end" },
          ...(canWrite(audience) ? [ui.Link({ label: "New order", screenId: "orders.new" })] : []),
          ui.Button({
            label: "Refresh",
            variant: "secondary",
            size: "sm",
            // Patches only if the node they address is on the screen the user
            // is looking at, and an action does not know which screen that is.
            // This button and `orders-table` are on the same screen, which is
            // what makes the patch safe to send.
            action: { actionId: "orders.refresh" },
          }),
        ),
      ),
    ),
  });
}

export function detailScreen(order: Order, audience: Audience = "internal"): ScreenResponse {
  // One flag, because approving and deleting are the same rule: a pending
  // order can still move, and any other order has already moved.
  const canApprove = order.status === "pending";

  return screen({
    id: "orders.detail",
    title: `Order ${order.id}`,
    breadcrumbs: [{ label: "Orders", screenId: "orders.list" }, { label: order.id }],
    ui: ui.Page(
      {},
      ui.Card(
        {},
        ui.KeyValueList({
          items: [
            { label: "Customer", value: order.customer },
            { label: "Total", value: money(order) },
            { label: "Status", value: order.status, as: "badge", tone: statusTone(order.status) },
            { label: "Placed", value: order.placedAt, as: "date" },
            ...(order.blockedByVehicleId
              ? [{ label: "Blocked by vehicle", value: order.blockedByVehicleId }]
              : []),
          ],
        }),
      ),
      // Spread so an external principal gets no action row at all, rather than
      // an empty one that renders as a stray gap.
      ...(canWrite(audience)
        ? [ui.Stack(
        { direction: "row", gap: "sm" },
        ui.Button({
          label: canApprove ? "Approve order" : "Already processed",
          variant: canApprove ? "primary" : "secondary",
          disabled: !canApprove,
          action: { actionId: "orders.approve", payload: { id: order.id } },
          // Spread rather than set to `undefined`: the catalog is strict, and
          // an explicitly-undefined optional is a different thing from an
          // absent one under `exactOptionalPropertyTypes`.
          ...(canApprove
            ? {
                confirm: {
                  title: "Approve this order?",
                  body: `${order.id} — ${money(order)}`,
                },
              }
            : {}),
        }),
        ui.Link({ label: "Edit", screenId: "orders.edit", params: { id: order.id } }),
        ui.Button({
          label: "Delete",
          variant: "danger",
          // Disabled on the same rule the repository enforces, for the same
          // reason Approve is: a live button that can only answer "only pending
          // orders can be deleted" asks the user to discover a rule the screen
          // already knew. The rule is still enforced server-side — this is the
          // screen agreeing with it, not replacing it.
          disabled: !canApprove,
          action: { actionId: "orders.delete", payload: { id: order.id } },
          // The hub draws its own confirmation, so a destructive action is
          // never one click. Declared rather than implemented: the dialog is
          // the shell's, and a satellite drawing its own would be drawing UI
          // the hub owns. Spread for the same `exactOptionalPropertyTypes`
          // reason as Approve's.
          ...(canApprove
            ? {
                confirm: {
                  title: "Delete this order?",
                  body: `Order ${order.id} will be removed. This cannot be undone.`,
                },
              }
            : {}),
        }),
      )]
        : []),
    ),
  });
}

/**
 * The order form, shared by create and edit.
 *
 * One builder for both because the fields are the same and the only
 * differences are the action it posts to, the values it starts from, and the
 * label on the button. Two builders would drift: a field added to create and
 * forgotten on edit is a field a user can set and then never change.
 *
 * This is the first screen in the portal that asks anyone to type. Everything
 * before it was tables, tiles and charts — the easy half of the claim that a
 * fixed vocabulary can carry an internal application.
 */
export function orderForm(options: {
  readonly actionId: string;
  readonly submitLabel: string;
  readonly order?: Order;
}): UiNode {
  const order = options.order;

  return ui.Form(
    { actionId: options.actionId, submitLabel: options.submitLabel },
    // The id travels with the submission rather than in the URL, so the action
    // does not have to trust a query parameter it never issued.
    ...(order ? [ui.Hidden({ name: "id", value: order.id })] : []),

    ui.Grid(
      { columns: 2 },
      ui.TextField({
        name: "customer",
        label: "Customer",
        required: true,
        placeholder: "Who is this order for?",
        ...(order ? { value: order.customer } : {}),
      }),
      ui.TextField({
        name: "contactEmail",
        label: "Contact email",
        required: true,
        help: "Where the confirmation goes.",
        ...(order ? { value: order.contactEmail } : {}),
      }),
      ui.NumberField({
        name: "total",
        label: "Total",
        required: true,
        min: 0.01,
        max: 100000,
        step: 0.01,
        ...(order ? { value: order.total } : {}),
      }),
      ui.Select({
        name: "currency",
        label: "Currency",
        required: true,
        options: CURRENCIES.map((code) => ({ label: code, value: code })),
        value: order?.currency ?? "USD",
      }),
      ui.DateField({
        name: "dueBy",
        label: "Due by",
        required: true,
        ...(order ? { value: order.dueBy } : {}),
      }),
      ui.MultiSelect({
        name: "tags",
        label: "Labels",
        help: "Hazmat orders need handling notes.",
        options: TAGS.map((tag) => ({ label: tag, value: tag })),
        ...(order ? { value: order.tags } : {}),
      }),
    ),

    ui.RadioGroup({
      name: "priority",
      label: "Priority",
      required: true,
      options: PRIORITIES.map((value) => ({ label: value, value })),
      value: order?.priority ?? "standard",
    }),

    ui.Checkbox({
      name: "expedited",
      label: "Expedite this order",
      help: "Critical orders are always expedited.",
      ...(order ? { checked: order.expedited } : {}),
    }),

    ui.TextArea({
      name: "notes",
      label: "Notes",
      rows: 3,
      ...(order?.notes ? { value: order.notes } : {}),
    }),
  );
}

/** `orders.new` — an empty form. */
export function newScreen(): ScreenResponse {
  return screen({
    id: "orders.new",
    title: "New order",
    breadcrumbs: [{ label: "Orders", screenId: "orders.list" }, { label: "New order" }],
    ui: ui.Page(
      { title: "New order" },
      ui.Section(
        { title: "Details" },
        orderForm({ actionId: "orders.create", submitLabel: "Create order" }),
      ),
    ),
  });
}

/** `orders.edit` — the same form, filled in. */
export function editScreen(order: Order): ScreenResponse {
  return screen({
    id: "orders.edit",
    title: `Edit ${order.id}`,
    // The order's own crumb carries no `screenId`: `orders.detail` requires an
    // `id`, and a breadcrumb has nowhere to put one — the schema is `{ label,
    // screenId }` and nothing else. Declaring the link anyway would name a
    // destination that answers 404 the day the hub starts honouring it.
    breadcrumbs: [
      { label: "Orders", screenId: "orders.list" },
      { label: order.id },
      { label: "Edit" },
    ],
    ui: ui.Page(
      { title: `Edit ${order.id}` },
      // Two different warnings, because the repository draws the line at
      // shipped/cancelled and not at "no longer pending". A single alert saying
      // "editing is refused" on an approved order was telling the user
      // something the satellite would then happily do.
      ...(order.status === "shipped" || order.status === "cancelled"
        ? [
            ui.Alert({
              level: "warning",
              title: "This order has moved on",
              message: `It is ${order.status}. Saving is refused, and the form below is here so you can see what it holds.`,
            }),
          ]
        : order.status === "approved"
          ? [
              ui.Alert({
                level: "info",
                title: "This order is approved",
                message: "Changes are still allowed, and they do not send it back for approval.",
              }),
            ]
          : []),
      ui.Section(
        { title: "Details" },
        orderForm({ actionId: "orders.update", submitLabel: "Save changes", order }),
      ),
    ),
  });
}
