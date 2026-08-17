import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { callMcpTool, mcpTools, serverInstructions } from "@portal/mcp-server";
import { agentInvokerDeps, buildAgentSurface } from "@/lib/agent";
import { currentPrincipal } from "@/lib/session";

/**
 * The hub, as an MCP server.
 *
 * One endpoint, everything this account can reach. A staff member points Claude
 * Desktop or an IDE agent here and gets the same tools the in-hub assistant
 * gets, filtered by the same `entitle()` the screens use — the difference is
 * the wire, not the policy.
 *
 * **Stateless, and a fresh server per request.** `sessionIdGenerator` is
 * undefined and `enableJsonResponse` is on, so every POST is self-contained:
 * two hub replicas need share nothing, and a restart costs a host nothing but a
 * reconnect. The surface is rebuilt per request for the same reason it is in
 * the agent route — a satellite that changed what it offers is reflected on the
 * next call rather than whenever a session happens to end.
 */

export async function POST(request: Request): Promise<Response> {
  let principal;
  try {
    principal = currentPrincipal();
  } catch {
    return new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const surface = await buildAgentSurface(principal);
  const deps = agentInvokerDeps(principal, surface);

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
    // Copied into mutable arrays because the SDK's result type is not readonly,
    // and `isError` is spread rather than set so it is absent on success —
    // `exactOptionalPropertyTypes` treats an explicit `undefined` as a value.
    return {
      content: [...result.content],
      ...(result.isError === true ? { isError: true } : {}),
    };
  });

  // `sessionIdGenerator: undefined` is how this transport is told to run
  // statelessly — the SDK's own documentation shows exactly this call. Its type
  // marks the property optional rather than `| undefined`, which
  // `exactOptionalPropertyTypes` reads as "may be absent, may not be
  // undefined". Omitting the key instead would turn sessions *on*, so the
  // assertion is here and the alternative is not silently worse.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  } as unknown as ConstructorParameters<typeof WebStandardStreamableHTTPServerTransport>[0]);

  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // Nothing is kept between requests, so nothing may be left holding a socket.
    await transport.close();
  }
}
