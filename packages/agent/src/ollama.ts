import type { ContentBlock, Message, ModelClient, ModelReply } from "./loop";

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
 * Regulated data reaches the model through tool results, and a local model is
 * a different answer to whatever data-handling terms the hosted deployment is
 * expected to meet — one nobody has reviewed. The committed default stays the
 * hosted Azure AI Foundry deployment, and this turns on by choice.
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
 * The two disagree about where a tool result lives. Our shape carries it as a
 * block inside a *user* message; Ollama expects a separate message with role
 * `tool`. A translation that kept the user role would hand the model a user
 * turn full of JSON and no indication it came from a tool.
 */
function toOllamaMessages(system: string, messages: readonly Message[]): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: "system", content: system }];
  // `tool_name` is the *tool's* name. It is carried on the `tool_use` block and
  // a `tool_result` only refers back to it by id, so the pairing is rebuilt
  // here — sending the id instead told the model a tool called `local_1`
  // answered, which is the one thing a tool message exists to say correctly.
  const toolNames = namesByToolUseId(messages);

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
      out.push({
        role: "tool",
        content: result.content,
        tool_name: toolNames.get(result.tool_use_id) ?? result.tool_use_id,
      });
    }

    if (message.role === "assistant" && toolUses.length > 0) {
      // The prose that came with the calls is dropped, and it has to be.
      //
      // Ollama renders history through the model's own Go template, and
      // qwen2.5's is `{{ if .Content }}{{ .Content }}{{ else if .ToolCalls }}
      // <tool_call>…` — an `else`. One word of preamble in `content` and every
      // tool call in that turn vanishes from the prompt, so the model is shown
      // a `<tool_response>` answering a call it cannot see it made.
      //
      // Splitting them across two assistant messages does not help: Ollama
      // merges consecutive messages of the same role before templating, so the
      // pair arrives as the one message again. Verified against the running
      // model, asking it to name an argument it had just passed — "Ulaanbaatar"
      // with the content empty, and "UNKNOWN" with the prose kept, in either
      // order.
      //
      // Which of the two to lose is not a close call. Grounding makes the model
      // cite the id of a call it made itself, and `render_screen` composes from
      // calls it has to remember making; a preamble is filler. Losing the call
      // is a screen that cannot be composed — which is some part of what the
      // skipped e2e test currently blames on the model's size.
      out.push({
        role: "assistant",
        content: "",
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

function namesByToolUseId(messages: readonly Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") names.set(block.id, block.name);
    }
  }
  return names;
}

/**
 * Ids minted per *conversation*, not per client.
 *
 * A counter living in the closure looked equivalent and was not: the whole
 * conversation travels with the request and `modelClient()` is built fresh for
 * each one, so a per-client counter restarts at 1 on every turn and re-mints
 * `local_1` for a call the history already answered. The loop then reads that
 * call as answered, never runs it, asks the model again, and burns every turn
 * it has — and grounding, which resolves a citation by id, would have two
 * different reads wearing the same one. So the next id is read off the history
 * instead. Short and sequential rather than a UUID on purpose: the model has to
 * copy these ids into `render_screen` citations by hand.
 */
function localIdMinter(messages: readonly Message[]): () => string {
  let highest = 0;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      const match = /^local_(\d+)$/.exec(block.id);
      if (match?.[1] !== undefined) highest = Math.max(highest, Number(match[1]));
    }
  }
  return () => `local_${(highest += 1)}`;
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
  // A trailing slash is what a human writes in a `.env`, and `${baseUrl}/api/chat`
  // turns it into a double slash Ollama answers 404 to.
  const baseUrl = (options.baseUrl ?? OLLAMA_URL).replace(/\/+$/, "");
  const model = options.model ?? OLLAMA_MODEL;
  const timeoutMs = options.timeoutMs ?? 180_000;

  return {
    async respond({ system, messages, tools }): Promise<ModelReply> {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({
            model,
            stream: false,
            options: { num_ctx: CONTEXT_TOKENS, temperature: 0 },
            messages: toOllamaMessages(system, messages),
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
      } catch (cause) {
        // The message below about `ollama serve` only ever reached anyone whose
        // Ollama was already running — a server that is *not* running never
        // answers, so `fetch` rejects with a bare `TypeError: fetch failed`
        // and the route turns that into "could not complete that request".
        // Not being started is the first thing that goes wrong here, so it is
        // the case that has to say so.
        const timedOut = (cause as { name?: unknown } | null)?.name === "TimeoutError";
        throw new Error(
          timedOut
            ? `the local model at ${baseUrl} did not answer within ${timeoutMs}ms. ` +
              `The first call also loads ${model} into memory, which is slower than the rest.`
            : `could not reach the local model at ${baseUrl}. Is \`ollama serve\` running?`,
          { cause },
        );
      }

      if (!response.ok) {
        // The body, not just the status. Ollama explains a 400 there, and a
        // provider that swallows it leaves the caller with "something was
        // wrong with a request they cannot see".
        const detail = await response.text().catch(() => "");
        // Reaching a status at all means the server is up, so the question is
        // about the model rather than the daemon.
        throw new Error(
          `the local model answered ${response.status}: ${detail.slice(0, 500)}. ` +
            `Is ${model} pulled?`,
        );
      }

      const body = (await response.json()) as { message?: OllamaMessage; done_reason?: string };
      if (body.message === undefined) throw new Error("the local model returned no message");

      // The mirror of `azure.ts`'s `length` throw, and it matters for
      // the same reason: a generation cut off at the window can end part way
      // through a `tool_call`, and the loop would go on to make a tool call
      // with half its arguments. Ollama reports this only here — the HTTP call
      // is a clean 200 either way.
      if (body.done_reason === "length") {
        throw new Error(
          `the local model's reply was cut off at the ${CONTEXT_TOKENS}-token window.`,
        );
      }

      return { content: fromOllamaMessage(body.message, localIdMinter(messages)) };
    },
  };
}
