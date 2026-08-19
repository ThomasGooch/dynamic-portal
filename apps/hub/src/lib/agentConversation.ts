import type { Message } from "@portal/agent";
import { UiNodeSchema } from "@portal/protocol";
import type { AgentApiResult, SignedConversation } from "./agentApi";

/**
 * What the assistant panel keeps between screens, and how it is read back.
 *
 * The panel is mounted in the layout, so client-side navigation would leave it
 * alone — but the renderer's `Link` is a real anchor and an action's `navigate`
 * is a real navigation, both by design: PLAN.md wants deep links, the back
 * button and copyable URLs, which is exactly what iframes and micro-frontends
 * break. Every one of those is a full page load, and a full page load takes
 * React state with it.
 *
 * The encode/decode pair lives here rather than in the component because it is
 * the part with rules — an owner to match, a shape to refuse, an interrupted
 * turn to rewrite — and none of those are reachable from a browser test. The
 * component keeps the `sessionStorage` calls; this module never touches
 * `window`.
 *
 * `sessionStorage`, not `localStorage`: the conversation carries tool results —
 * real tenant data — so it has no business outliving the tab it was read in.
 */

/**
 * The key, versioned.
 *
 * The value's shape is this release's, and the panel renders what it finds. A
 * payload written by a build whose `AgentApiResult` differed would otherwise be
 * handed to the renderer, and there is no error boundary above the panel to
 * catch what that throws. Bump this whenever the stored shape changes.
 */
export const CONVERSATION_STORAGE_KEY = "portal.assistant.conversation.v1";

/** `Omit` that survives a union instead of collapsing it into one member. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A turn's result as the panel keeps it: without the conversation.
 *
 * Every successful `AgentApiResult` carries the whole signed history — that is
 * how the hub stays stateless between turns — but the panel already holds the
 * current one, and a turn that keeps its own copy means an n-turn thread stores
 * the history n+1 times. Against a 128 KB conversation budget that reaches a
 * browser's few-megabyte quota in tens of turns, and a refused write is
 * swallowed, so what the next load restores is the last copy that fit: the
 * thread silently rewinds. Nothing renders these two fields.
 */
export type TurnResult = DistributiveOmit<AgentApiResult, keyof SignedConversation>;

export interface Turn {
  readonly id: number;
  readonly question: string;
  readonly result: TurnResult | undefined;
}

export interface StoredConversation {
  /** Tenant and subject the thread belongs to. */
  readonly owner: string;
  readonly open: boolean;
  readonly messages: Message[];
  readonly signature: string;
  readonly turns: Turn[];
}

/**
 * What a turn interrupted by the navigation that stored it becomes.
 *
 * `JSON.stringify` drops an `undefined` property, so an in-flight turn stored
 * mid-request comes back with no `result` — indistinguishable from one still
 * waiting, except that the request died with the document and nothing will ever
 * complete it. Restored as "Working…" it would spin forever, on this load and
 * every load after it. Not reported as a failure either: the hub may well have
 * run the turn, and only the reply was lost.
 */
export const INTERRUPTED: TurnResult = {
  ok: false,
  message: "The page changed before this answer arrived. Ask again to see the reply.",
};

/** Drops the conversation a result carried; see `TurnResult`. */
export function forDisplay(result: AgentApiResult): TurnResult {
  if (!result.ok) return result;
  const { messages: _messages, signature: _signature, ...display } = result;
  return display;
}

/** True for a value the panel can render without throwing partway through. */
function isRenderableResult(value: unknown): value is TurnResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  if (result["ok"] === false) return typeof result["message"] === "string";
  if (result["ok"] !== true) return false;

  if (result["kind"] === "answer") return typeof result["text"] === "string";

  if (result["kind"] === "confirm") {
    const pending = result["pending"];
    if (typeof pending !== "object" || pending === null) return false;
    const write = pending as Record<string, unknown>;
    // `pending.title` is read and `pending.args` is walked with
    // `Object.entries`, neither of them guarded at the point of use.
    //
    // `toolUseId` is checked too even though nothing renders it: it is what
    // "Approve and run" posts back, so a restored confirmation missing it draws
    // a working button that silently approves nothing. Refusing the payload
    // gives the user an empty panel and a reason to ask again, which is a
    // better answer than a write that appears to have been authorised.
    return (
      typeof write["title"] === "string" &&
      typeof write["toolUseId"] === "string" &&
      typeof write["args"] === "object" &&
      write["args"] !== null
    );
  }

  if (result["kind"] === "screen") {
    const citations = result["citations"];
    const allowed = result["allowedSatelliteIds"];
    return (
      Array.isArray(citations) &&
      citations.every(
        (citation) =>
          typeof citation === "object" &&
          citation !== null &&
          typeof (citation as Record<string, unknown>)["toolName"] === "string",
      ) &&
      Array.isArray(allowed) &&
      allowed.every((id) => typeof id === "string") &&
      // The renderer walks this tree, and the protocol's own schema is the
      // thing that says whether it can be walked.
      UiNodeSchema.safeParse(result["ui"]).success
    );
  }

  return false;
}

function isTurn(value: unknown): value is Turn {
  if (typeof value !== "object" || value === null) return false;
  const turn = value as Record<string, unknown>;
  if (typeof turn["id"] !== "number" || typeof turn["question"] !== "string") return false;
  return turn["result"] === undefined || isRenderableResult(turn["result"]);
}

/** True for a message the panel's pending-call check can read without throwing. */
function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return typeof message["role"] === "string" && Array.isArray(message["content"]);
}

/** The stored form. Paired with `decodeConversation` so the shape has one home. */
export function encodeConversation(state: StoredConversation): string {
  return JSON.stringify(state);
}

/**
 * A stored conversation, or nothing.
 *
 * Shape-checked rather than trusted: this is storage another tab, an extension
 * or a stale release could have written, and a malformed restore would break
 * the panel on every load with no way back except devtools.
 *
 * The owner is checked before any of it is returned. The hub refuses a history
 * it did not sign for the subject asking, but that 400 only arrives once the
 * next question is *sent* — and the panel draws the restored turns, tool
 * results and all, long before that. Whoever signs in next on this tab gets a
 * clean panel, not somebody else's thread waiting to be discarded.
 */
export function decodeConversation(raw: string | null, owner: string): StoredConversation | undefined {
  if (raw === null) return undefined;
  let parsed: Partial<StoredConversation>;
  try {
    parsed = JSON.parse(raw) as Partial<StoredConversation>;
  } catch {
    // Unreadable storage is no storage. A thrown parse would take the whole
    // shell down, for a convenience.
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  // Somebody else's thread, or one from before the owner was recorded.
  if (parsed.owner !== owner) return undefined;
  if (typeof parsed.signature !== "string") return undefined;
  if (!Array.isArray(parsed.messages) || !Array.isArray(parsed.turns)) return undefined;
  if (!parsed.messages.every(isMessage)) return undefined;
  if (!parsed.turns.every(isTurn)) return undefined;

  return {
    owner,
    open: parsed.open === true,
    messages: parsed.messages,
    signature: parsed.signature,
    turns: parsed.turns.map((turn) =>
      turn.result === undefined ? { ...turn, result: INTERRUPTED } : turn,
    ),
  };
}
