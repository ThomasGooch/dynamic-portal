import { describe, expect, it } from "vitest";
import { conversationBudget, trimConversation } from "./trim";
import type { Message } from "./loop";

/** A question, an answer that called a tool, and the tool's reply. */
function turn(n: number, padding = 0): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: `question ${n}` }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: `toolu_${n}`, name: "orders__list", input: {} }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `toolu_${n}`, content: `rows${"x".repeat(padding)}` },
      ],
    },
  ];
}

const bytes = (messages: readonly Message[]) => Buffer.byteLength(JSON.stringify(messages), "utf8");

describe("the conversation budget", () => {
  it("leaves room for the question the same body still has to carry", () => {
    // The trim measures the history as issued; what comes back is that history
    // *plus* whatever the user typed. A budget equal to the cap would refuse
    // conversations it had just declared acceptable.
    expect(conversationBudget(256 * 1024)).toBeLessThan(256 * 1024);
    expect(conversationBudget(256 * 1024)).toBe(128 * 1024);
  });
});

describe("trimming a conversation the hub would otherwise refuse", () => {
  it("returns a conversation that already fits untouched", () => {
    const messages = [...turn(1), ...turn(2)];
    expect(trimConversation(messages, 10_000)).toEqual(messages);
  });

  it("drops the oldest turns until the rest fits", () => {
    const messages = [...turn(1), ...turn(2), ...turn(3)];
    const trimmed = trimConversation(messages, bytes([...turn(2), ...turn(3)]));

    expect(trimmed).toEqual([...turn(2), ...turn(3)]);
    expect(bytes(trimmed)).toBeLessThanOrEqual(bytes([...turn(2), ...turn(3)]));
  });

  it("never begins with an orphaned tool result, which the API rejects outright", () => {
    // The cut this exists to prevent. A `tool_result` is a user-role message,
    // so a trim that merely looked for "the next user turn" would happily start
    // a conversation with a result whose `tool_use` it had just deleted.
    const messages = [...turn(1), ...turn(2), ...turn(3)];

    for (let budget = 0; budget <= bytes(messages); budget += 17) {
      const first = trimConversation(messages, budget)[0];
      expect(first?.role, `budget ${budget}`).toBe("user");
      expect(
        first?.content.some((block) => block.type === "tool_result"),
        `budget ${budget}`,
      ).toBe(false);
    }
  });

  it("keeps every tool_use that still has a result, and every result its call", () => {
    const messages = [...turn(1), ...turn(2), ...turn(3)];

    for (let budget = 0; budget <= bytes(messages); budget += 17) {
      const trimmed = trimConversation(messages, budget);
      const calls = new Set(
        trimmed.flatMap((m) => m.content.filter((b) => b.type === "tool_use").map((b) => b.id)),
      );
      const results = trimmed.flatMap((m) =>
        m.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id),
      );
      for (const id of results) expect(calls.has(id), `budget ${budget}, ${id}`).toBe(true);
    }
  });

  it("returns the oversized turn rather than editing evidence inside it", () => {
    // One tool result larger than the whole budget. There is no cut that helps:
    // trimming *within* a turn would mean rewriting a `tool_result` that
    // grounding cites, and a citation resolving to a doctored result is worse
    // than a conversation that has to end.
    const huge = turn(1, 5_000);
    expect(trimConversation(huge, 100)).toEqual(huge);
  });

  it("measures bytes rather than characters, so non-ASCII is not undercounted", () => {
    const ascii = [...turn(1), ...turn(2)];
    const wide: Message[] = ascii.map((m) => ({
      ...m,
      content: m.content.map((b) => (b.type === "text" ? { ...b, text: "《".repeat(60) } : b)),
    }));

    const budget = bytes(wide) - 1;
    // `String.length` would credit the wide text at a third of its weight and
    // conclude it already fits.
    expect(JSON.stringify(wide).length).toBeLessThan(bytes(wide));
    expect(bytes(trimConversation(wide, budget))).toBeLessThanOrEqual(
      Math.max(budget, bytes(wide.slice(3))),
    );
  });
});
