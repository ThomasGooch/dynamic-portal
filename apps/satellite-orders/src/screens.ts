import {
  CURRENT_PROTOCOL_VERSION,
  type Manifest,
  type ScreenResponse,
  type UiNode,
} from "@portal/protocol";
import type { Order } from "./repository";

/**
 * The satellite's declaration and its screens.
 *
 * Note what is absent: any styling. The satellite says "this is a Table with
 * these columns" and "this Badge has tone danger"; how a danger badge looks is
 * the hub's business. That is the whole bargain.
 */

const money = (order: Order): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: order.currency }).format(
    order.total,
  );

const statusTone = (status: Order["status"]): string =>
  ({ pending: "warning", approved: "success", shipped: "info", cancelled: "danger" })[status];

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
  return {
    protocol: CURRENT_PROTOCOL_VERSION,
    satelliteId: "orders",
    displayName: "Order Management",
    description: "Track, review, and approve customer orders.",
    audience: ["internal"],
    screens: [
      {
        id: "orders.list",
        title: "Orders",
        description: "All orders for the current tenant.",
        audience: ["internal"],
      },
      {
        id: "orders.detail",
        title: "Order detail",
        params: [{ name: "id", required: true, description: "Order id" }],
        audience: ["internal"],
      },
    ],
    actions: [
      {
        id: "orders.approve",
        title: "Approve order",
        description: "Move a pending order to approved.",
        audience: ["internal"],
      },
      {
        id: "orders.refresh",
        title: "Refresh orders",
        description: "Re-read the order table without leaving the screen.",
        audience: ["internal"],
      },
    ],
    nav: [{ screenId: "orders.list", label: "Orders", section: "Operations", order: 10 }],
    healthPath: "/healthz",
  };
}

export function ordersTable(orders: Order[]): UiNode {
  return {
    type: "Table",
    id: "orders-table",
    props: {
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
    },
  };
}

export function listScreen(orders: Order[]): ScreenResponse {
  const pending = orders.filter((o) => o.status === "pending").length;
  const blocked = orders.filter((o) => o.blockedByVehicleId).length;
  return {
    protocol: CURRENT_PROTOCOL_VERSION,
    screen: { id: "orders.list", title: "Orders" },
    ui: {
      type: "Page",
      children: [
        {
          type: "Grid",
          props: { columns: 3 },
          children: [
            { type: "StatTile", props: { label: "Total orders", value: String(orders.length) } },
            { type: "StatTile", props: { label: "Pending", value: String(pending), tone: "warning" } },
            {
              type: "StatTile",
              props: {
                label: "Blocked",
                value: String(blocked),
                tone: blocked > 0 ? "danger" : "muted",
              },
            },
          ],
        },
        {
          type: "Section",
          props: { title: "All orders" },
          children: [
            ordersTable(orders),
            {
              type: "Stack",
              props: { direction: "row", gap: "sm", align: "end" },
              children: [
                {
                  type: "Button",
                  props: {
                    label: "Refresh",
                    variant: "secondary",
                    size: "sm",
                    // Patches only if the node they address is on the screen
                    // the user is looking at, and an action does not know which
                    // screen that is. This button and `orders-table` are on the
                    // same screen, which is what makes the patch safe to send.
                    action: { actionId: "orders.refresh" },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    meta: { ttlSeconds: 15 },
  };
}

export function detailScreen(order: Order): ScreenResponse {
  const canApprove = order.status === "pending";
  return {
    protocol: CURRENT_PROTOCOL_VERSION,
    screen: {
      id: "orders.detail",
      title: `Order ${order.id}`,
      breadcrumbs: [{ label: "Orders", screenId: "orders.list" }, { label: order.id }],
    },
    ui: {
      type: "Page",
      children: [
        {
          type: "Card",
          children: [
            {
              type: "KeyValueList",
              props: {
                items: [
                  { label: "Customer", value: order.customer },
                  { label: "Total", value: money(order) },
                  { label: "Status", value: order.status, as: "badge", tone: statusTone(order.status) },
                  { label: "Placed", value: order.placedAt, as: "date" },
                  ...(order.blockedByVehicleId
                    ? [{ label: "Blocked by vehicle", value: order.blockedByVehicleId }]
                    : []),
                ],
              },
            },
          ],
        },
        {
          type: "Stack",
          props: { direction: "row", gap: "sm" },
          children: [
            {
              type: "Button",
              props: {
                label: canApprove ? "Approve order" : "Already processed",
                variant: canApprove ? "primary" : "secondary",
                disabled: !canApprove,
                action: { actionId: "orders.approve", payload: { id: order.id } },
                confirm: canApprove
                  ? { title: "Approve this order?", body: `${order.id} — ${money(order)}` }
                  : undefined,
              },
            },
          ],
        },
      ],
    },
  };
}
