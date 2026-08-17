import { describe, expect, it } from "vitest";
import { signValue, tenantKey, verifyValue } from "./integrity";
import { tenantAuditKey } from "./audit";

const KEY = tenantKey("root-secret", "conversation.v1", "acme");

describe("keys", () => {
  it("separates purposes, so one key never verifies another's payloads", () => {
    expect(tenantKey("root", "audit.v1", "acme")).not.toEqual(
      tenantKey("root", "conversation.v1", "acme"),
    );
  });

  it("separates tenants, so one tenant's conversation cannot be replayed into another", () => {
    expect(tenantKey("root", "conversation.v1", "acme")).not.toEqual(
      tenantKey("root", "conversation.v1", "globex"),
    );
  });

  it("derives the audit key identically to the function that already existed", () => {
    // Load-bearing: a different derivation here would silently invalidate every
    // digest already written.
    expect(tenantKey("root", "audit.v1", "acme")).toEqual(tenantAuditKey("root", "acme"));
  });

  it("refuses an empty root secret", () => {
    expect(() => tenantKey("", "conversation.v1", "acme")).toThrow(/root key is required/i);
  });
});

describe("signing", () => {
  const conversation = [
    { role: "user", content: [{ type: "text", text: "how many?" }] },
    { role: "assistant", content: [{ type: "text", text: "two" }] },
  ];

  it("verifies what it signed", () => {
    expect(verifyValue(conversation, signValue(conversation, KEY), KEY)).toBe(true);
  });

  it("does not care about key order, because JSON round trips", () => {
    const reordered = [
      { content: [{ text: "how many?", type: "text" }], role: "user" },
      { content: [{ text: "two", type: "text" }], role: "assistant" },
    ];
    expect(verifyValue(reordered, signValue(conversation, KEY), KEY)).toBe(true);
  });

  it("does care about order in an array, where order is meaning", () => {
    expect(verifyValue([...conversation].reverse(), signValue(conversation, KEY), KEY)).toBe(false);
  });

  it("refuses a single altered character", () => {
    const tampered = JSON.parse(JSON.stringify(conversation)) as typeof conversation;
    tampered[1]!.content[0]!.text = "three";
    expect(verifyValue(tampered, signValue(conversation, KEY), KEY)).toBe(false);
  });

  it("refuses an appended message", () => {
    // The case that matters: a fabricated `tool_result` carrying invented data
    // that grounding would otherwise accept as evidence.
    const extended = [
      ...conversation,
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "{}" }] },
    ];
    expect(verifyValue(extended, signValue(conversation, KEY), KEY)).toBe(false);
  });

  it("refuses a signature made with another tenant's key", () => {
    const theirs = tenantKey("root-secret", "conversation.v1", "globex");
    expect(verifyValue(conversation, signValue(conversation, theirs), KEY)).toBe(false);
  });

  it("returns false rather than throwing on a malformed signature", () => {
    // A caller is deciding whether to trust input; an exception on a
    // wrong-length string makes the failure path noisier than the success one.
    for (const bad of ["", "nope", "0".repeat(63), "z".repeat(64)]) {
      expect(verifyValue(conversation, bad, KEY), bad).toBe(false);
    }
  });
});
