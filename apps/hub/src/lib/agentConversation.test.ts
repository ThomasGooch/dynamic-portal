import { describe, expect, it } from "vitest";
import type { Message } from "@portal/agent";
import type { AgentApiResult } from "./agentApi";
import {
  decodeConversation,
  encodeConversation,
  forDisplay,
  INTERRUPTED,
  type StoredConversation,
} from "./agentConversation";

/**
 * The rules the assistant panel applies to storage it did not write.
 *
 * A browser test can prove a conversation survives a navigation; it cannot
 * reach a payload from another subject, a stale release or a half-finished
 * turn, and those are the cases where getting it wrong breaks the shell on
 * every load. Hence a tier that can hand `decodeConversation` anything.
 */

const OWNER = "acme:dev@acme.example";

const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];

const conversation: StoredConversation = {
  owner: OWNER,
  open: true,
  messages,
  signature: "abc123",
  turns: [{ id: 0, question: "hello", result: { ok: true, kind: "answer", text: "hi" } }],
};

describe("decodeConversation", () => {
  it("reads back what it wrote", () => {
    expect(decodeConversation(encodeConversation(conversation), OWNER)).toEqual(conversation);
  });

  it("has nothing to read", () => {
    expect(decodeConversation(null, OWNER)).toBeUndefined();
  });

  it("refuses a thread stored by somebody else", () => {
    // The hub would refuse this history too, but only once it is *sent* — and
    // the panel draws the tool results in it before that.
    const encoded = encodeConversation({ ...conversation, owner: "acme:someone.else@acme.example" });
    expect(decodeConversation(encoded, OWNER)).toBeUndefined();
  });

  it("refuses a payload from before the owner was recorded", () => {
    const { owner: _owner, ...older } = conversation;
    expect(decodeConversation(JSON.stringify(older), OWNER)).toBeUndefined();
  });

  it("refuses what is not JSON at all", () => {
    expect(decodeConversation("{ not json", OWNER)).toBeUndefined();
    expect(decodeConversation("null", OWNER)).toBeUndefined();
    expect(decodeConversation('"a string"', OWNER)).toBeUndefined();
  });

  it("refuses a conversation whose parts are the wrong kind of thing", () => {
    for (const broken of [
      { ...conversation, messages: "not an array" },
      { ...conversation, turns: {} },
      { ...conversation, signature: 7 },
      { ...conversation, messages: [{ role: "user" }] },
      { ...conversation, turns: [{ id: "0", question: "hello", result: undefined }] },
    ]) {
      expect(decodeConversation(JSON.stringify(broken), OWNER)).toBeUndefined();
    }
  });

  it("refuses a result shaped like no answer this release can draw", () => {
    // What a stale release's payload looks like: enough of the envelope to get
    // past `ok`, and nothing the renderer can walk. Drawn as-is it throws
    // inside the panel, on this load and every load after it.
    for (const result of [
      { ok: true },
      { ok: true, kind: "answer" },
      { ok: true, kind: "confirm", pending: { title: "Ship it" } },
      // Renderable, and useless: "Approve and run" posts `toolUseId`, so this
      // one draws a button that approves nothing at all.
      { ok: true, kind: "confirm", pending: { title: "Ship it", args: {} } },
      { ok: true, kind: "screen", ui: null, citations: [], allowedSatelliteIds: [] },
      { ok: true, kind: "screen", ui: { type: "" }, citations: [], allowedSatelliteIds: [] },
      { ok: true, kind: "screen", ui: { type: "Stack" }, citations: [{}], allowedSatelliteIds: [] },
      { ok: false },
    ]) {
      const encoded = JSON.stringify({
        ...conversation,
        turns: [{ id: 0, question: "hello", result }],
      });
      expect(decodeConversation(encoded, OWNER)).toBeUndefined();
    }
  });

  it("accepts a screen the renderer can walk", () => {
    const result = {
      ok: true,
      kind: "screen",
      ui: { type: "Stack", children: [{ type: "Text", props: { value: "12" } }] },
      citations: [{ toolName: "orders.list" }],
      allowedSatelliteIds: ["orders"],
    };
    const encoded = JSON.stringify({
      ...conversation,
      turns: [{ id: 0, question: "hello", result }],
    });
    expect(decodeConversation(encoded, OWNER)?.turns[0]?.result).toEqual(result);
  });

  it("does not restore an interrupted turn as one still working", () => {
    // `JSON.stringify` drops an `undefined` property, so a turn stored
    // mid-request comes back with no `result` — and nothing is left to finish
    // it, because the request died with the document.
    const encoded = encodeConversation({
      ...conversation,
      turns: [{ id: 0, question: "hello", result: undefined }],
    });
    expect(JSON.parse(encoded).turns[0]).not.toHaveProperty("result");

    const restored = decodeConversation(encoded, OWNER);
    expect(restored?.turns[0]?.result).toEqual(INTERRUPTED);
  });
});

describe("forDisplay", () => {
  it("keeps the conversation out of every turn that carried one", () => {
    // Each successful result carries the whole signed history — the hub is
    // stateless, so that is how the conversation gets back. Storing a copy per
    // turn is what walks a long thread into the storage quota.
    const result: AgentApiResult = {
      ok: true,
      kind: "answer",
      text: "hi",
      messages,
      signature: "abc123",
    };

    expect(forDisplay(result)).toEqual({ ok: true, kind: "answer", text: "hi" });
  });

  it("leaves a refusal alone", () => {
    const refusal: AgentApiResult = { ok: false, message: "no" };
    expect(forDisplay(refusal)).toBe(refusal);
  });
});
