import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authorize, type Principal } from "@portal/identity";
import type { Audience, Role } from "@portal/protocol";
import { z } from "zod";
import type { Order, OrderRepository } from "./repository";

/**
 * This satellite's own MCP server.
 *
 * Most satellites should not have one. The hub shims PUP into tools for free,
 * and a shimmed satellite is agent-reachable with no second server to run, no
 * second surface to secure and no second thing to keep in step. The registry
 * says as much: `mcpUrl` is optional and two of three satellites omit it.
 *
 * So the bar for hosting one is that the tools must be things the shim cannot
 * make, and everything here clears it:
 *
 * **A nested query.** `orders.search` filters on lists and a date range inside
 * one `filters` object. A PUP action parameter is a scalar or a list of
 * scalars, deliberately — nesting it would cost the protocol, the shim, the
 * argument validator, the public façade and three generated SDKs, to serve one
 * satellite's need. That expressiveness belongs on this side of the line.
 *
 * **An operation with no screen.** `orders.reconcile` clears stale blocks in
 * bulk. Nothing renders it, so the shim has nothing to find; before MCP, the
 * only projections of this capability were a cron entry and a person with
 * database access.
 *
 * **Data, given rather than recovered.** Both tools return `structuredContent`.
 * The shim's read tools work by extracting rows back out of a rendered table,
 * which is a reconstruction limited to what a screen chose to show. These hand
 * over what the satellite already had.
 *
 * What does *not* change: the principal is the same signed token the PUP
 * endpoints verify, the scopes are checked here rather than at the hub, and the
 * tenant comes from the token and never from an argument. An MCP surface that
 * relaxed any of those would be a second door into the same data with a weaker
 * lock — which is the failure mode worth naming out loud, because it is the one
 * that looks like progress while it happens.
 */

/**
 * The nested shape, which is the entire argument for this file existing.
 *
 * Written as Zod because the SDK derives the published JSON Schema from it, so
 * there is one definition rather than a schema and a validator that agree until
 * they do not.
 */
const searchInput = {
  filters: z
    .object({
      status: z.array(z.enum(["pending", "approved", "shipped", "cancelled"])).optional(),
      priority: z.array(z.enum(["standard", "express", "critical"])).optional(),
      placedBetween: z
        .object({ from: z.string().optional(), to: z.string().optional() })
        .strict()
        .optional(),
    })
    .strict(),
  limit: z.number().int().positive().max(200).optional(),
};

const searchOutput = {
  matches: z.array(
    z.object({
      id: z.string(),
      customer: z.string(),
      status: z.string(),
      priority: z.string(),
      total: z.number(),
      currency: z.string(),
      placedAt: z.string(),
      blockedByVehicleId: z.string().optional(),
    }),
  ),
  total: z.number().int(),
  truncated: z.boolean(),
};

const reconcileInput = {
  vehiclesBackInService: z.array(z.string()).min(1),
  dryRun: z.boolean().optional(),
};

const reconcileOutput = {
  cleared: z.array(z.string()),
  dryRun: z.boolean(),
};

export interface McpServerOptions {
  readonly repository: OrderRepository;
}

/**
 * Who these tools are declared to.
 *
 * Per tool rather than per satellite, because this satellite's manifest
 * declares `["internal", "external"]` and then *narrows* per resource — every
 * write on it is `["internal"]`. Checking the satellite's own audience here
 * would therefore be an audience check that never refuses anybody, and
 * `orders.reconcile` is a bulk write, so it would be the widest thing on the
 * satellite reachable by the narrowest credential.
 *
 * `internal` is also exactly what the hub's `adopt.ts` defaults an adopted MCP
 * tool to, so the two sides agree by construction rather than by coincidence.
 * Widening one without the other refuses, which is the direction a
 * disagreement should fail in.
 */
const DECLARED_AUDIENCE: readonly Audience[] = ["internal"];

/**
 * The org roles these tools are offered to — the satellite's own ceiling, the
 * same set its manifest declares and the same one the hub's `adopt.ts` derives
 * from the satellite layer. Without it this MCP endpoint would be a second door
 * with a weaker lock than the shimmed path: `orders.reconcile`, a bulk write,
 * reachable directly by a principal (e.g. platform-only) the hub's gateway
 * refuses on roles. Any-of, and internal-only via `authorize`.
 */
const DECLARED_ROLES: readonly Role[] = ["leadership", "engineering", "finance"];

/**
 * A server per request.
 *
 * Stateless is the right shape here: the hub opens a connection, lists or calls,
 * and closes. Holding sessions would mean holding per-principal state on the
 * satellite, and the whole point of the signed token is that there is none —
 * every request carries who is asking. It also means a restarted satellite
 * costs the hub a reconnection rather than a wedged session.
 */
export function createMcpServer(options: McpServerOptions, principal: Principal): McpServer {
  const server = new McpServer(
    { name: "satellite-orders", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "orders.search",
    {
      title: "Search orders",
      description:
        "Search this tenant's orders with a structured query. Filters combine: an order must " +
        "match every branch given. Returns the matching orders as data.",
      inputSchema: searchInput,
      outputSchema: searchOutput,
      // The hub reads this to decide whether a confirmation card stands between
      // the model and the call. A tool that does not say is treated as a write.
      annotations: { readOnlyHint: true },
    },
    async ({ filters, limit }) => {
      const denied = refuse(principal, DECLARED_AUDIENCE, ["orders.read"], DECLARED_ROLES);
      if (denied !== undefined) return denied;

      const all = options.repository.list(principal.tenantId).filter((order) => {
        if (filters.status !== undefined && !filters.status.includes(order.status)) return false;
        if (filters.priority !== undefined && !filters.priority.includes(order.priority)) {
          return false;
        }
        if (filters.placedBetween !== undefined) {
          // Compared as ISO strings: `placedAt` is a full timestamp and the
          // bounds are dates, so a lexicographic compare is a date compare and
          // `to` is inclusive of that whole day.
          const { from, to } = filters.placedBetween;
          if (from !== undefined && order.placedAt < from) return false;
          if (to !== undefined && order.placedAt.slice(0, 10) > to) return false;
        }
        return true;
      });

      const capped = all.slice(0, limit ?? 200);
      const structured = {
        matches: capped.map(summarize),
        total: all.length,
        truncated: capped.length < all.length,
      };

      return {
        // Both, deliberately. The structured half is what the hub grounds a
        // rendered figure against; the text is what a model reads when it is
        // answering in prose and never draws a screen at all.
        content: [{ type: "text" as const, text: describeSearch(structured) }],
        structuredContent: structured,
      };
    },
  );

  server.registerTool(
    "orders.reconcile",
    {
      title: "Reconcile blocked orders",
      description:
        "Clear the blocks held by vehicles that are back in service. Use dryRun to see what " +
        "would change without changing it.",
      inputSchema: reconcileInput,
      outputSchema: reconcileOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ vehiclesBackInService, dryRun }) => {
      const denied = refuse(principal, DECLARED_AUDIENCE, ["orders.write"], DECLARED_ROLES);
      if (denied !== undefined) return denied;

      const cleared = options.repository.unblock(
        principal.tenantId,
        vehiclesBackInService,
        dryRun === true,
      );
      const structured = { cleared, dryRun: dryRun === true };

      return {
        content: [
          {
            type: "text" as const,
            text:
              cleared.length === 0
                ? "No blocked orders were waiting on those vehicles."
                : `${dryRun === true ? "Would clear" : "Cleared"} ${cleared.length} order(s): ${cleared.join(", ")}.`,
          },
        ],
        structuredContent: structured,
      };
    },
  );

  return server;
}

/**
 * The scope check, on this side of the wire.
 *
 * The hub checks entitlement too, and that redundancy is the design: if
 * authorization lived only in the hub, one hub bug would be a cross-tenant
 * disclosure across every solution at once. Here it is an availability
 * incident. It also keeps this satellite correct when it is called directly,
 * which happens during incidents and migrations whatever the diagram says.
 */
function refuse(
  principal: Principal,
  audience: readonly Audience[],
  rbacScopes: readonly string[],
  roles?: readonly Role[],
): { content: { type: "text"; text: string }[]; isError: true } | undefined {
  const decision = authorize(principal, { audience, rbacScopes, roles });
  if (decision.allowed) return undefined;
  return {
    content: [{ type: "text", text: decision.reason }],
    isError: true,
  };
}

/** Only the fields a model needs. The rest is this satellite's business. */
const summarize = (order: Order) => ({
  id: order.id,
  customer: order.customer,
  status: order.status,
  priority: order.priority,
  total: order.total,
  currency: order.currency,
  placedAt: order.placedAt,
  ...(order.blockedByVehicleId === undefined
    ? {}
    : { blockedByVehicleId: order.blockedByVehicleId }),
});

function describeSearch(result: { matches: readonly unknown[]; total: number }): string {
  if (result.total === 0) return "No orders matched.";
  return `${result.total} order(s) matched; ${result.matches.length} returned.`;
}

/**
 * One transport per request, closed with the response.
 *
 * `sessionIdGenerator: undefined` is the SDK's stateless mode, and
 * `enableJsonResponse` makes a call answer as a plain JSON body rather than an
 * SSE stream — the hub's client does one call and closes, so a stream would be
 * a long-lived socket carrying a single message.
 */
export async function handleMcpRequest(
  options: McpServerOptions,
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const server = createMcpServer(options, principal);
  // `sessionIdGenerator: undefined` is the SDK's own documented stateless mode,
  // but its options type declares the field as `() => string` — a mismatch that
  // only surfaces because this repository compiles with
  // `exactOptionalPropertyTypes`. Cast the options here, in one line, rather
  // than relax the setting for the whole app; the same applies to `connect`
  // below, whose `Transport` interface declares handlers the implementation
  // types as optional.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);

  // Closed when the response ends, whichever way it ends. Without this a
  // refused or abandoned request leaks a server and a transport per call.
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport as unknown as Parameters<McpServer["connect"]>[0]);
  await transport.handleRequest(req, res, body);
}
