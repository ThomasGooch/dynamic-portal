import type { ContentBlock, Message, ModelClient, ModelReply } from "./loop";

/**
 * The vendor SDK, behind the seam — except there is no SDK here, on purpose.
 *
 * Azure OpenAI's chat-completions endpoint is a stable, documented REST call,
 * so this talks to it with plain `fetch`, the same choice `ollama.ts` makes.
 * That keeps the vendor confined to one small file, adds no new dependency,
 * and — unlike the old Anthropic client, which could never be exercised
 * without a network — makes this file testable by mocking `fetch`.
 *
 * Targets Azure's newer OpenAI-compatible "v1" data plane, not the classic
 * `/openai/deployments/{deployment}/chat/completions?api-version=...` shape.
 * Measured against a live resource: the classic shape's api-version values
 * (e.g. `2024-10-21`) come back `400 "API version not supported"` on a v1
 * endpoint, and the deployment belongs in the request body as `model`, not
 * the URL path. `PORTAL_AZURE_ENDPOINT` is expected to be the full base URL
 * through `/openai/v1` (no trailing `/chat/completions`).
 */

/**
 * Enough for a screen of any size this catalog can express, and not so much
 * that a runaway generation is expensive before `maxTurns` notices.
 */
const MAX_COMPLETION_TOKENS = 8192;

export interface AzureClientOptions {
  readonly apiKey: string;
  readonly endpoint: string;
  readonly deployment: string;
  /**
   * Omitted by default — a live check found the endpoint answers with no
   * `api-version` at all, and the one version string tried instead 400s.
   * Some resources' preview features gate on `api-version=preview`, so it
   * stays overridable via `PORTAL_AZURE_API_VERSION` rather than removed.
   */
  readonly apiVersion?: string;
}

interface AzureToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

interface AzureMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_calls?: readonly AzureToolCall[];
  readonly tool_call_id?: string;
}

export function azureClient(options: AzureClientOptions): ModelClient {
  // A trailing slash is what a human writes in a `.env`, and doubling it into
  // the path is how that becomes a 404 nobody can read the cause of.
  const endpoint = options.endpoint.replace(/\/+$/, "");
  const url =
    options.apiVersion === undefined || options.apiVersion === ""
      ? `${endpoint}/chat/completions`
      : `${endpoint}/chat/completions?api-version=${options.apiVersion}`;

  return {
    async respond({ system, messages, tools }): Promise<ModelReply> {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "api-key": options.apiKey },
        body: JSON.stringify({
          model: options.deployment,
          max_completion_tokens: MAX_COMPLETION_TOKENS,
          messages: toAzureMessages(system, messages),
          tools: tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.input_schema,
            },
          })),
        }),
      });

      if (!response.ok) {
        // The body, not just the status: Azure explains a 400 there, and a
        // client that swallows it leaves the caller with a request they
        // cannot see.
        const detail = await response.text().catch(() => "");
        throw new Error(`Azure AI Foundry answered ${response.status}: ${detail.slice(0, 500)}`);
      }

      const body = (await response.json()) as {
        choices?: readonly { message?: AzureMessage; finish_reason?: string }[];
      };
      const choice = body.choices?.[0];
      if (choice?.message === undefined) {
        throw new Error("Azure AI Foundry returned no message");
      }

      // Two finish reasons produce content the loop cannot use, and both look
      // like an ordinary success to a caller that only reads `content`. A
      // filtered reply arrives as HTTP 200 with no tool call, so the loop
      // would take the empty text for an answer; a length cutoff can land
      // mid tool-call, which the loop would go on to make with half its
      // arguments.
      if (choice.finish_reason === "content_filter") {
        throw new Error("The model declined to answer this request.");
      }
      if (choice.finish_reason === "length") {
        throw new Error("The model's reply did not fit within the token budget.");
      }

      return { content: fromAzureMessage(choice.message) };
    },
  };
}

/**
 * Our message shape into Azure's chat-completions shape.
 *
 * Unlike Ollama, Azure allows prose and `tool_calls` on the same assistant
 * message, so there is no need to drop one for the other.
 */
function toAzureMessages(system: string, messages: readonly Message[]): AzureMessage[] {
  const out: AzureMessage[] = [{ role: "system", content: system }];

  for (const message of messages) {
    const text = message.content
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    const toolUses = message.content.filter(
      (block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use",
    );
    const toolResults = message.content.filter(
      (block): block is Extract<ContentBlock, { type: "tool_result" }> =>
        block.type === "tool_result",
    );

    // Results first, as separate `tool` messages: Azure answers a tool call
    // through `tool_call_id`, not through message order, but the results
    // still have to precede the turn that reads them.
    for (const result of toolResults) {
      out.push({ role: "tool", content: result.content, tool_call_id: result.tool_use_id });
    }

    if (message.role === "assistant" && toolUses.length > 0) {
      out.push({
        role: "assistant",
        content: text === "" ? null : text,
        tool_calls: toolUses.map((use) => ({
          id: use.id,
          type: "function",
          function: { name: use.name, arguments: JSON.stringify(use.input) },
        })),
      });
      continue;
    }

    // `opaque` blocks carry a vendor-specific signature that means nothing
    // here, so they are dropped rather than forwarded.
    if (text !== "") out.push({ role: message.role, content: text });
  }

  return out;
}

/** Azure's reply into ours. */
function fromAzureMessage(message: AzureMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (message.content !== null && message.content !== "") {
    blocks.push({ type: "text", text: message.content });
  }

  for (const call of message.tool_calls ?? []) {
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(call.function.arguments) as Record<string, unknown>;
    } catch (cause) {
      throw new Error(
        `Azure AI Foundry returned a tool call whose arguments were not valid JSON: ${call.function.arguments}`,
        { cause },
      );
    }
    blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
  }

  return blocks;
}
