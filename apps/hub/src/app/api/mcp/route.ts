import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { callMcpTool, mcpTools, serverInstructions } from "@portal/mcp-server";
import { agentInvokerDeps, buildAgentSurface, isAgentAllowedForTenant } from "@/lib/agent";
import { currentPrincipal } from "@/lib/session";

/**
 * The hub, as an MCP server.
 *
 * One endpoint, everything this account can reach. A staff member points Claude
 * Desktop or an IDE agent here and gets the same tools the in-hub assistant
 * gets, filtered by the same `entitle()` the screens use — the difference is
 * the wire, not the policy.
 *
 * **Stateless, and a fresh server per request.** No session id generator and
 * `enableJsonResponse` on, so every POST is self-contained: two hub replicas
 * need share nothing, and a restart costs a host nothing but a reconnect. The
 * surface is rebuilt per request for the same reason it is in the agent route —
 * a satellite that changed what it offers is reflected on the next call rather
 * than whenever a session happens to end.
 */

export async function POST(request: Request): Promise<Response> {
  let principal;
  try {
    principal = await currentPrincipal();
  } catch {
    return new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  let surface;
  let invoker;
  try {
    surface = await buildAgentSurface(principal);
    // Inside the same guard: `agentInvokerDeps` derives this tenant's audit key,
    // and `auditConfig()` throws when the mandatory audit settings are missing.
    // Outside, that throw is Next's HTML error page — the one thing this handler
    // must never hand an MCP host.
    invoker = agentInvokerDeps(principal);
  } catch {
    // `getPortal()` throws when the registry file or the principal secret is
    // missing. Letting that escape hands the host Next's error page — HTML, and
    // a stack trace in development — where the agent route deliberately returns
    // a sentence. A host can act on a JSON-RPC error and cannot act on either.
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "The portal could not list what this account can reach." },
      }),
      { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  }
  const { deps, flush } = invoker;

  const server = new Server(
    { name: "dynamic-portal", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      // Read before any tool is called. It is where the governed writes are
      // named, so an agent that cannot see them sends the user to the portal
      // rather than reporting the thing impossible.
      instructions: serverInstructions(surface),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: mcpTools(surface).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (message) => {
    const result = await callMcpTool(
      surface,
      message.params.name,
      (message.params.arguments ?? {}) as Record<string, unknown>,
      principal,
      deps,
    );
    // Before the response leaves. A tool call whose record is still in flight
    // is a tool call the log may never show.
    await flush();
    // Copied into mutable arrays because the SDK's result type is not readonly,
    // and `isError` is spread rather than set so it is absent on success —
    // `exactOptionalPropertyTypes` treats an explicit `undefined` as a value.
    return {
      content: [...result.content],
      ...(result.isError === true ? { isError: true } : {}),
    };
  });

  // Stateless because `sessionIdGenerator` is absent, not because it is set to
  // `undefined`: the transport stores `options.sessionIdGenerator` verbatim and
  // then tests it for `undefined`, so omitting the key and passing the key are
  // the same transport. Omitting it is the one `exactOptionalPropertyTypes`
  // accepts, which is why there is no assertion here — and no assertion means a
  // typo in `enableJsonResponse` is still a type error rather than a silent
  // fall back to SSE that every JSON-mode host would hang on.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request);
    await flush();
    return response;
  } finally {
    // Nothing is kept between requests, so nothing may be left holding a socket.
    await transport.close();
  }
}
