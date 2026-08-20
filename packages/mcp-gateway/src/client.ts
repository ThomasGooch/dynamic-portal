import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { signPrincipal, type Principal } from "@portal/identity";
import type { Satellite } from "@portal/registry";

/**
 * Talking to a satellite that hosts its own MCP server.
 *
 * One client, for every satellite that declares `mcpUrl`. That is the whole
 * bargain: a satellite gains the ability to offer capabilities its screens
 * cannot express, and the hub gains no per-satellite code — the alternative,
 * every time, is widening PUP for one satellite's need. `string[]` and `file`
 * each cost the protocol, the shim, the argument validator, the public façade
 * and three SDKs. This moves that expressiveness to the satellite's side.
 *
 * **What the gateway gives up here, deliberately.** A shim tool's arguments are
 * checked against a schema the gateway itself derived, so it can refuse a bad
 * call before the satellite sees it. An MCP tool's schema is the satellite's,
 * and may be nested in ways `JsonObjectSchema` cannot describe — which is the
 * point of using MCP at all. So arguments are passed through and the satellite
 * validates them. That is the correct authority either way: the satellite has
 * always been the thing that decides whether a call is legal.
 *
 * **The principal still travels.** A satellite's MCP server verifies the same
 * signed token its PUP endpoints do, and enforces the same tenant scoping. An
 * MCP surface that skipped that would be a second door into the same data with
 * a weaker lock.
 */

/** A tool as its satellite describes it, before the gateway namespaces it. */
export interface SatelliteMcpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** The satellite's own JSON Schema, passed through unread. */
  readonly inputSchema: Record<string, unknown>;
  readonly readOnly: boolean;
}

export interface McpClientOptions {
  readonly principalSecret: string;
  /** A satellite on a laptop is slow; a satellite that has stopped is silent. */
  readonly timeoutMs?: number;
}

async function connect(
  satellite: Satellite,
  principal: Principal,
  options: McpClientOptions,
): Promise<{ client: Client; close: () => Promise<void> }> {
  if (satellite.mcpUrl === undefined) {
    throw new Error(`${satellite.id} declares no mcpUrl`);
  }

  const transport = new StreamableHTTPClientTransport(new URL(satellite.mcpUrl), {
    requestInit: {
      headers: {
        // The same credential the PUP client presents. A satellite must be able
        // to answer "who is asking" identically on both surfaces, or its own
        // authorization has a hole shaped like a protocol.
        authorization: `Bearer ${signPrincipal(principal, options.principalSecret)}`,
      },
    },
  });

  const client = new Client(
    { name: "dynamic-portal-hub", version: "1.0.0" },
    { capabilities: {} },
  );

  // The SDK declares `sessionId: string` on its transport interface and
  // `string | undefined` on this implementation, which only collides because
  // this repository compiles with `exactOptionalPropertyTypes`. Cast here, in
  // one line, rather than relax the setting for every package — the mismatch is
  // in the dependency's own types, not in what it does.
  await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
  return { client, close: () => client.close() };
}

/**
 * Every tool a satellite offers, or nothing.
 *
 * Failure is not an error here: a satellite whose MCP server is down should
 * cost the agent that satellite's tools and nothing else. The same reasoning
 * as the circuit breaker on the PUP path — one solution being unreachable is
 * not the portal being unreachable.
 */
export async function listSatelliteTools(
  satellite: Satellite,
  principal: Principal,
  options: McpClientOptions,
): Promise<{ tools: SatelliteMcpTool[]; reason?: string }> {
  let session: { client: Client; close: () => Promise<void> } | undefined;
  try {
    session = await connect(satellite, principal, options);
    const listed = await session.client.listTools();

    return {
      tools: listed.tools.map((tool) => ({
        name: tool.name,
        title: tool.title ?? tool.name,
        description: tool.description ?? tool.name,
        inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
        // A tool that does not say is treated as a write, because assuming a
        // read is the assumption that lets an agent change something without a
        // confirmation card.
        readOnly: tool.annotations?.readOnlyHint === true,
      })),
    };
  } catch (error) {
    return { tools: [], reason: `mcp server unreachable: ${describe(error)}` };
  } finally {
    await session?.close().catch(() => {});
  }
}

export type McpCallOutcome =
  | {
      readonly ok: true;
      /** Whatever text blocks the tool returned, joined. */
      readonly content: string;
      /**
       * The tool's `structuredContent`, when it sent any.
       *
       * This is the half of MCP the shim has no answer for. A PUP read is
       * extracted *out of* a rendered screen — the gateway reads a table
       * component and recovers rows from it, which works but is a reconstruction
       * of data the satellite already had. An MCP tool hands the data over
       * directly, so nothing has to be inferred from a presentation of it.
       */
      readonly structured?: Record<string, unknown>;
    }
  | {
      readonly ok: false;
      /**
       * Whether the tool refused or the connection did.
       *
       * `refused` is the tool running normally and saying no — the text is
       * something the satellite wrote for a model to read, so it travels. Any
       * other failure is transport, and its text is an exception message that
       * can name internal hosts and paths; the gateway reports the reason and
       * withholds the detail, exactly as the PUP proxy already does.
       */
      readonly kind: "refused" | "unreachable";
      readonly message: string;
    };

/** Calls one tool. The satellite validates the arguments; the gateway does not. */
export async function callSatelliteTool(
  satellite: Satellite,
  principal: Principal,
  options: McpClientOptions,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpCallOutcome> {
  let session: { client: Client; close: () => Promise<void> } | undefined;
  try {
    session = await connect(satellite, principal, options);
    const result = await session.client.callTool({ name, arguments: { ...args } });

    // `isError` is the protocol's way of saying the tool ran and refused, which
    // is different from the call failing. Both reach the model as text, but only
    // the second is worth retrying.
    const text = (Array.isArray(result.content) ? result.content : [])
      .filter((part): part is { type: "text"; text: string } => part?.type === "text")
      .map((part) => part.text)
      .join("\n");

    if (result.isError === true) {
      return {
        ok: false,
        kind: "refused",
        message: text === "" ? "the tool reported an error" : text,
      };
    }

    const structured = result.structuredContent;
    return isObject(structured)
      ? { ok: true, content: text, structured }
      : { ok: true, content: text };
  } catch (error) {
    return { ok: false, kind: "unreachable", message: `mcp call failed: ${describe(error)}` };
  } finally {
    await session?.close().catch(() => {});
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";
