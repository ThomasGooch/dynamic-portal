import type { Message } from "./loop";

/**
 * Keeping the conversation inside the size the hub will accept back.
 *
 * The hub is stateless between turns, so the whole history goes to the browser
 * and returns as the next request's body. That body is capped, like every other
 * body the hub accepts. Those two facts together have a sharp edge: the history
 * only ever grows, so without this a hub would hand out a conversation, sign
 * it, and refuse that same conversation on the very next turn — wiping a
 * session mid-sentence for a user who did nothing wrong.
 *
 * The cap is not the bug; issuing something you will not accept is. So the trim
 * happens on the way *out*, before signing, and the signature covers what
 * actually left. A conversation that has been trimmed is still entirely valid:
 * what it loses is the oldest turns, which is what a person scrolling back
 * would lose too.
 */

/**
 * How much of the request body the conversation may occupy.
 *
 * Half of it, because the same body also carries the question the user is about
 * to ask, the approvals, and JSON framing — and because the trim is measured
 * against the history *as issued*, while what comes back is that history plus
 * whatever the user typed into it. Half leaves room for a paste that would
 * otherwise turn a working conversation into a refused one.
 */
export function conversationBudget(maxBodyBytes: number): number {
  return Math.floor(maxBodyBytes / 2);
}

/** Bytes on the wire, not characters: non-ASCII text weighs more than it reads. */
function weigh(messages: readonly Message[]): number {
  return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

/**
 * A message that may legally begin a conversation.
 *
 * Not merely any user turn: a `tool_result` is a user-role message, and one
 * whose matching `tool_use` has been trimmed away is an orphan the API rejects
 * outright. Cutting at a real question is the only cut that always leaves
 * something the model can be handed.
 */
function startsATurn(message: Message): boolean {
  return (
    message.role === "user" && !message.content.some((block) => block.type === "tool_result")
  );
}

/**
 * Drops whole turns from the front until the rest fits, or until dropping more
 * would leave nothing.
 *
 * Returns the input unchanged when it already fits, which is the ordinary case
 * — this is a backstop for long sessions, not a routine transformation.
 *
 * **What it cannot do.** If a single turn is itself over budget — one tool
 * result carrying thousands of rows — there is no cut that helps, and the
 * oversized turn is returned as it is. Trimming inside a turn would mean
 * editing a `tool_result` whose content grounding cites, and a citation that
 * resolves to a doctored result is worse than a conversation that ends.
 */
export function trimConversation(messages: readonly Message[], budget: number): Message[] {
  if (weigh(messages) <= budget) return [...messages];

  // Every index a conversation could legally restart from, nearest first.
  for (let index = 1; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (candidate === undefined || !startsATurn(candidate)) continue;

    const kept = messages.slice(index);
    if (weigh(kept) <= budget) return [...kept];
  }

  return [...messages];
}
