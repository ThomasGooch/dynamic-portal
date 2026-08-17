import type { FlatSpec } from "@portal/catalog";
import type { ToolResult, ToolSurface } from "@portal/mcp-gateway";
import { groundSpec, type ToolCallRecord } from "./grounding";
import { lowerSpec } from "./lower";
import { RENDER_SCREEN_TOOL, SYSTEM_PROMPT, toolDefinitions } from "./tools";

/**
 * The agent loop.
 *
 * **The whole conversation is the state, and it travels with the request.** The
 * SDK's `toolRunner` would run this loop for us, and it is the right tool when
 * a loop runs to completion in one process. Ours cannot: a write pauses for a
 * human to approve it, and that pause crosses an HTTP boundary and possibly a
 * container restart. Keeping a runner alive server-side, keyed by a session,
 * would make the hub stateful for the one feature most likely to be interrupted.
 * So the loop is written out here and the message list is passed back and forth,
 * which also makes the whole thing a pure function of its inputs.
 *
 * Resuming is not a special case for the same reason. The loop starts by
 * looking for tool calls the assistant has made and nobody has answered; on a
 * fresh turn there are none and it asks the model, and on a resumed turn there
 * is exactly the write the user has just approved.
 */

export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    }
  | {
      readonly type: "tool_result";
      readonly tool_use_id: string;
      readonly content: string;
      readonly is_error?: boolean;
    }
  /**
   * Anything else the model sent back, carried through untouched.
   *
   * Thinking blocks are the reason this exists. They arrive with a signature,
   * they have to be in the history on the next turn for that signature to
   * verify, and this loop has no business reading them. Dropping what it does
   * not understand would break the conversation on the second turn only — the
   * kind of bug that survives every test written against a single turn.
   */
  | { readonly type: "opaque"; readonly raw: unknown };

export interface Message {
  readonly role: "user" | "assistant";
  readonly content: readonly ContentBlock[];
}

export interface ModelReply {
  readonly content: readonly ContentBlock[];
}

/** The seam the SDK sits behind, so the loop is testable without a network. */
export interface ModelClient {
  respond(input: {
    readonly system: string;
    readonly messages: readonly Message[];
    readonly tools: ReturnType<typeof toolDefinitions>;
  }): Promise<ModelReply>;
}

export interface PendingWrite {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly title: string;
  readonly description: string;
  readonly args: Record<string, unknown>;
}

/** What a rendered screen is derived from, so the UI can show it. */
export interface Citation {
  readonly toolCallId: string;
  readonly toolName: string;
}

export type AgentOutcome =
  | {
      readonly kind: "screen";
      readonly spec: FlatSpec;
      readonly citations: readonly Citation[];
      readonly messages: readonly Message[];
    }
  | { readonly kind: "answer"; readonly text: string; readonly messages: readonly Message[] }
  | {
      readonly kind: "confirm";
      readonly pending: PendingWrite;
      readonly messages: readonly Message[];
    }
  | { readonly kind: "failed"; readonly reason: string; readonly messages: readonly Message[] };

export interface RunDeps {
  readonly client: ModelClient;
  readonly invoke: (
    name: string,
    args: Record<string, unknown>,
    options: { readonly confirmed: boolean },
  ) => Promise<ToolResult>;
  /** A model that will not stop is a bill, not a bug report. */
  readonly maxTurns?: number;
}

export interface RunInput {
  readonly messages: readonly Message[];
  readonly surface: ToolSurface;
  /** Tool-use ids the user has approved since the last turn. */
  readonly approvals?: readonly string[];
}

const DEFAULT_MAX_TURNS = 8;

export async function runAgent(input: RunInput, deps: RunDeps): Promise<AgentOutcome> {
  const tools = toolDefinitions(input.surface);
  const approvals = new Set(input.approvals ?? []);
  let messages: Message[] = [...input.messages];

  for (let turn = 0; turn < (deps.maxTurns ?? DEFAULT_MAX_TURNS); turn += 1) {
    const pending = unansweredToolUses(messages);

    if (pending.length === 0) {
      const reply = await deps.client.respond({ system: SYSTEM_PROMPT, messages, tools });
      messages = [...messages, { role: "assistant", content: reply.content }];
      if (!reply.content.some((block) => block.type === "tool_use")) {
        return { kind: "answer", text: textOf(reply.content), messages };
      }
      continue;
    }

    const results: ContentBlock[] = [];

    for (const use of pending) {
      if (use.name === RENDER_SCREEN_TOOL) {
        const drawn = draw(use.input, messages);
        if (drawn.ok) {
          // The turn ends here. Any other call the assistant made alongside the
          // screen is abandoned, which costs nothing: the screen is the answer.
          return {
            kind: "screen",
            spec: drawn.spec,
            citations: citationsIn(messages),
            messages: [...messages, { role: "user", content: results }],
          };
        }
        // Fed back rather than fatal: the model is told which node failed and
        // gets to correct it, which is most of what the issue messages are for.
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: drawn.message,
          is_error: true,
        });
        continue;
      }

      const confirmed = approvals.has(use.id);
      const result = await deps.invoke(use.name, use.input, { confirmed });

      if (!result.ok && result.reason === "needs-confirmation") {
        // Returned *before* the result is appended, so the unanswered call is
        // still in the history. That is what makes the resumed turn pick up
        // exactly here.
        const descriptor = input.surface.byName.get(use.name);
        return {
          kind: "confirm",
          pending: {
            toolUseId: use.id,
            toolName: use.name,
            title: descriptor?.title ?? use.name,
            description: descriptor?.description ?? "",
            args: use.input,
          },
          messages,
        };
      }

      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: JSON.stringify(payloadOf(result)),
        ...(result.ok ? {} : { is_error: true }),
      });
    }

    messages = [...messages, { role: "user", content: results }];
  }

  return {
    kind: "failed",
    reason: "The assistant did not reach an answer within the turns allowed.",
    messages,
  };
}

/**
 * What the model is shown of a tool's result.
 *
 * A read is the extracted data and nothing else — no envelope the model has to
 * unwrap, and no field the gateway chose not to include. `kind` is here so the
 * grounding pass can find the reads again when the history is replayed, which
 * is how a resumed turn still knows what the earlier calls returned.
 */
function payloadOf(result: ToolResult): Record<string, unknown> {
  if (!result.ok) return { kind: "error", message: result.message };
  if (result.kind === "read") return { kind: "read", data: result.data };
  return {
    kind: "write",
    outcome: result.outcome,
    ...(result.message === undefined ? {} : { message: result.message }),
    ...(result.fieldErrors === undefined ? {} : { fieldErrors: result.fieldErrors }),
  };
}

function draw(
  input: Record<string, unknown>,
  messages: readonly Message[],
): { ok: true; spec: FlatSpec } | { ok: false; message: string } {
  const lowered = lowerSpec(input);
  if (!lowered.ok) {
    return { ok: false, message: describe("This screen is not valid", lowered.issues) };
  }

  const grounded = groundSpec(lowered.spec, readsIn(messages));
  if (!grounded.ok) {
    return { ok: false, message: describe("This screen is not grounded", grounded.issues) };
  }

  return { ok: true, spec: grounded.spec };
}

const describe = (
  headline: string,
  issues: readonly { elementId: string; message: string }[],
): string =>
  [`${headline}:`, ...issues.map((issue) => `- ${issue.elementId}: ${issue.message}`)].join("\n");

/** Tool calls the assistant has made that nothing has answered yet. */
function unansweredToolUses(
  messages: readonly Message[],
): { id: string; name: string; input: Record<string, unknown> }[] {
  const answered = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_result") answered.add(block.tool_use_id);
    }
  }

  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return [];

  return last.content
    .filter((block) => block.type === "tool_use")
    .filter((block) => !answered.has(block.id))
    .map((block) => ({ id: block.id, name: block.name, input: block.input }));
}

/**
 * The reads so far, rebuilt from the conversation.
 *
 * Replayed from the history rather than carried alongside it, because the
 * history is the only thing that survives the pause for a confirmation. What
 * the model was shown is exactly what grounding checks against, which is the
 * property worth having.
 */
function readsIn(messages: readonly Message[]): ToolCallRecord[] {
  const records: ToolCallRecord[] = [];

  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.content);
      } catch {
        continue;
      }
      const payload = parsed as { kind?: unknown; data?: unknown };
      if (payload.kind !== "read" || payload.data === undefined) continue;
      records.push({
        toolCallId: block.tool_use_id,
        data: payload.data as ToolCallRecord["data"],
      });
    }
  }

  return records;
}

/** Which tool produced each call id, so a screen can say where it came from. */
function citationsIn(messages: readonly Message[]): Citation[] {
  const citations: Citation[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_use" && block.name !== RENDER_SCREEN_TOOL) {
        citations.push({ toolCallId: block.id, toolName: block.name });
      }
    }
  }
  return citations;
}

const textOf = (content: readonly ContentBlock[]): string =>
  content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
