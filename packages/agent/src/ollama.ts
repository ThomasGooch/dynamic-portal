import type { ContentBlock, Message, ModelClient, ModelReply } from "./loop";
import type { toolDefinitions } from "./tools";

/**
 * A local model, behind the same interface the vendor sits behind.
 *
 * This exists for one reason: running the assistant's tests against a paid API
 * turned a regression suite into a bill. The deterministic portal costs
 * nothing to test and the agent cost real money per run, which is a poor
 * incentive to test the agent.
 *
 * It is also the clearest evidence the seam was worth having. PLAN.md rates
 * the model as the fastest-decaying dependency in the stack and puts it behind
 * the smallest interface in the repository — four lines. A second
 * implementation is this file and one branch in `modelClient()`; nothing in
 * the loop, the grounding pass or the route knows which one it is talking to.
 *
 * **What it is not.** Not a production path and not a compliance-reviewed one.
 * PLAN.md chose `claude-opus-5` because it is zero-data-retention eligible and
 * regulated data reaches the model through tool results; a local model is
 * simply a different answer to the same question, and one nobody has reviewed.
 * The committed default stays Anthropic, and this turns on by choice.
 */

export const OLLAMA_MODEL = "qwen2.5:7b";
export const OLLAMA_URL = "http://127.0.0.1:11434";

/**
 * Ollama defaults to a 4096-token window, which this agent overruns before the
 * conversation starts: the tool surface alone runs to thousands of tokens once
 * three satellites are registered. A truncated window does not fail loudly —
 * it silently drops the front of the prompt, so the model answers without the
 * system prompt it was given.
 */
const CONTEXT_TOKENS = 32_768;

interface OllamaToolCall {
  readonly id?: string;
  readonly function: { readonly name: string; readonly arguments: Record<string, unknown> };
}

interface OllamaMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly tool_calls?: readonly OllamaToolCall[];
  readonly tool_name?: string;
}

export interface OllamaClientOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  /** Bounded because a local model on a laptop is slow, not because it is remote. */
  readonly timeoutMs?: number;
}

/**
 * Our message shape into Ollama's.
 *
 * The two disagree about where a tool result lives. Anthropic carries it as a
 * block inside a *user* message; Ollama expects a separate message with role
 * `tool`. A translation that kept the user role would hand the model a user
 * turn full of JSON and no indication it came from a tool.
 */
function toOllamaMessages(system: string, messages: readonly Message[]): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: "system", content: system }];

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

    // Results first: they answer the turn before them, and Ollama reads the
    // list in order.
    for (const result of toolResults) {
      out.push({ role: "tool", content: result.content, tool_name: result.tool_use_id });
    }

    if (message.role === "assistant" && toolUses.length > 0) {
      out.push({
        role: "assistant",
        content: text,
        tool_calls: toolUses.map((use) => ({
          id: use.id,
          function: { name: use.name, arguments: use.input },
        })),
      });
      continue;
    }

    // An empty user turn would be rejected; an empty assistant turn is just
    // noise. `opaque` blocks — thinking, and anything else a vendor invents —
    // are dropped rather than forwarded, because they carry a signature from a
    // different model and mean nothing here.
    if (text !== "") out.push({ role: message.role, content: text });
  }

  return out;
}

/** Ollama's reply into ours. */
function fromOllamaMessage(message: OllamaMessage, fallbackId: () => string): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (message.content !== "") blocks.push({ type: "text", text: message.content });

  for (const call of message.tool_calls ?? []) {
    blocks.push({
      type: "tool_use",
      // Ollama does not always return an id, and grounding cites one: every
      // figure on an agent-composed screen names the call it came from. A
      // missing id would make every citation unresolvable, so one is minted.
      id: call.id ?? fallbackId(),
      name: call.function.name,
      input: call.function.arguments ?? {},
    });
  }

  return blocks;
}

export function ollamaClient(options: OllamaClientOptions = {}): ModelClient {
  const baseUrl = options.baseUrl ?? OLLAMA_URL;
  const model = options.model ?? OLLAMA_MODEL;
  const timeoutMs = options.timeoutMs ?? 180_000;
  let minted = 0;

  return {
    async respond({ system, messages, tools }): Promise<ModelReply> {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model,
          stream: false,
          options: { num_ctx: CONTEXT_TOKENS, temperature: 0 },
          messages: toOllamaMessages(system, messages),
          tools: (tools as ReturnType<typeof toolDefinitions>).map((tool) => ({
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
        // The body, not just the status. Ollama explains a 400 there, and a
        // provider that swallows it leaves the caller with "something was
        // wrong with a request they cannot see".
        const detail = await response.text().catch(() => "");
        throw new Error(
          `the local model answered ${response.status}: ${detail.slice(0, 500)}. ` +
            `Is \`ollama serve\` running, and is ${model} pulled?`,
        );
      }

      const body = (await response.json()) as { message?: OllamaMessage };
      if (body.message === undefined) throw new Error("the local model returned no message");

      return { content: fromOllamaMessage(body.message, () => `local_${(minted += 1)}`) };
    },
  };
}
