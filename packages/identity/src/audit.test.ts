import { describe, expect, it } from "vitest";
import { AuditEventSchema, canonicalDigest, screenRead, toolCall } from "./audit.js";
import type { Principal } from "./principal.js";

const alice: Principal = {
  sub: "alice@acme.example",
  tenantId: "acme",
  audience: "internal",
  scopes: ["orders.read"],
};

describe("canonicalDigest", () => {
  // The audit record must prove *what was asked* without storing it, because
  // the parameters carry regulated data. That is only meaningful if the same
  // request always produces the same digest.
  it("is stable across key order", () => {
    expect(canonicalDigest({ a: 1, b: 2 })).toBe(canonicalDigest({ b: 2, a: 1 }));
  });

  it("is stable across nested key order", () => {
    expect(canonicalDigest({ x: { a: 1, b: [1, { p: 1, q: 2 }] } })).toBe(
      canonicalDigest({ x: { b: [1, { q: 2, p: 1 }] as unknown[], a: 1 } }),
    );
  });

  it("distinguishes different values", () => {
    expect(canonicalDigest({ id: "1" })).not.toBe(canonicalDigest({ id: "2" }));
  });

  it("distinguishes a missing key, an undefined one and a null one", () => {
    // Three different requests. A digest that collapses any pair of them
    // reports two distinct questions as the same question.
    const digests = [
      canonicalDigest({ a: 1 }),
      canonicalDigest({ a: 1, b: undefined }),
      canonicalDigest({ a: 1, b: null }),
    ];
    expect(new Set(digests).size).toBe(3);
  });

  it("distinguishes two dates, which enumerate to no own properties", () => {
    const early = canonicalDigest({ from: new Date("2020-01-01T00:00:00.000Z") });
    const late = canonicalDigest({ from: new Date("2024-06-06T00:00:00.000Z") });
    expect(early).not.toBe(late);
    expect(early).not.toBe(canonicalDigest({ from: {} }));
  });

  it("digests a bigint rather than throwing on it", () => {
    expect(canonicalDigest({ total: 10n })).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalDigest({ total: 10n })).not.toBe(canonicalDigest({ total: 11n }));
  });

  it("does not preserve array order-insensitivity — order is meaning", () => {
    expect(canonicalDigest([1, 2])).not.toBe(canonicalDigest([2, 1]));
  });

  // Parameters come from a request body, so their depth is the caller's choice.
  // A recursive walk would overflow the stack here — after the request had
  // already been authorized and served.
  it("digests a deeply nested value without overflowing the stack", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 20_000; i += 1) {
      const next: Record<string, unknown> = {};
      cursor["a"] = next;
      cursor = next;
    }
    cursor["leaf"] = 1;
    expect(canonicalDigest(deep)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses a circular structure rather than looping", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    expect(() => canonicalDigest(cyclic)).toThrow(TypeError);
  });

  it("digests a value referenced twice without calling it circular", () => {
    const shared = { a: 1 };
    expect(canonicalDigest({ x: shared, y: shared })).toMatch(/^[a-f0-9]{64}$/);
  });

  it("never contains the input", () => {
    const digest = canonicalDigest({ ssn: "123-45-6789" });
    expect(digest).not.toContain("123");
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("audit events", () => {
  it("records a screen read", () => {
    const event = screenRead({
      principal: alice,
      satelliteId: "orders",
      screenId: "orders.list",
      params: { page: "2" },
      outcome: { status: "ok", httpStatus: 200 },
      latencyMs: 12,
      at: "2026-08-16T10:00:00.000Z",
      id: "evt_1",
    });
    expect(() => AuditEventSchema.parse(event)).not.toThrow();
    expect(event.principal.tenantId).toBe("acme");
  });

  it("stores a digest of parameters, never the parameters", () => {
    const event = screenRead({
      principal: alice,
      satelliteId: "orders",
      screenId: "orders.detail",
      params: { id: "ord-1001", note: "patient referral" },
      outcome: { status: "ok" },
      latencyMs: 3,
      at: "2026-08-16T10:00:00.000Z",
      id: "evt_2",
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("patient referral");
    expect(serialized).not.toContain("ord-1001");
    if (event.action.kind !== "screen.read") throw new Error("wrong kind");
    expect(event.action.paramsDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("carries explicitly declared subjects, because a digest cannot answer 'which records'", () => {
    // The trade-off, stated: a digest proves what was asked but cannot be read
    // back. A caller that needs "which records did this touch" declares the
    // identifiers it considers safe to retain.
    const event = screenRead({
      principal: alice,
      satelliteId: "orders",
      screenId: "orders.detail",
      params: { id: "ord-1001" },
      subjects: ["order:ord-1001"],
      outcome: { status: "ok" },
      latencyMs: 3,
      at: "2026-08-16T10:00:00.000Z",
      id: "evt_3",
    });
    if (event.action.kind !== "screen.read") throw new Error("wrong kind");
    expect(event.action.subjects).toEqual(["order:ord-1001"]);
  });

  it("records a tool call with the id that grounds a rendered value", () => {
    // This is what makes the grounding rule answerable: every number on an
    // agent-composed screen cites a toolCallId, and this record is what that
    // id resolves to.
    const event = toolCall({
      principal: alice,
      satelliteId: "orders",
      toolName: "orders.search",
      toolCallId: "toolu_abc",
      args: { status: "pending" },
      outcome: { status: "ok" },
      latencyMs: 40,
      at: "2026-08-16T10:00:00.000Z",
      id: "evt_4",
    });
    expect(() => AuditEventSchema.parse(event)).not.toThrow();
    if (event.action.kind !== "tool.call") throw new Error("wrong kind");
    expect(event.action.toolCallId).toBe("toolu_abc");
  });

  it("rejects an event with an unknown action kind", () => {
    expect(() =>
      AuditEventSchema.parse({
        id: "e",
        at: "2026-08-16T10:00:00.000Z",
        principal: { sub: "a", tenantId: "t", audience: "internal" },
        action: { kind: "mystery" },
        outcome: { status: "ok" },
        latencyMs: 1,
      }),
    ).toThrow();
  });

  it("rejects unknown top-level fields, so the record cannot drift", () => {
    const event = screenRead({
      principal: alice,
      satelliteId: "orders",
      screenId: "orders.list",
      params: {},
      outcome: { status: "ok" },
      latencyMs: 1,
      at: "2026-08-16T10:00:00.000Z",
      id: "evt_5",
    });
    expect(() => AuditEventSchema.parse({ ...event, extra: true })).toThrow();
  });

  it("never records the principal's scopes — they are authorization input, not evidence", () => {
    const event = screenRead({
      principal: alice,
      satelliteId: "orders",
      screenId: "orders.list",
      params: {},
      outcome: { status: "ok" },
      latencyMs: 1,
      at: "2026-08-16T10:00:00.000Z",
      id: "evt_6",
    });
    expect(JSON.stringify(event)).not.toContain("orders.read");
  });

  it("records a denial as a first-class outcome, not an absence", () => {
    // A missing record is indistinguishable from a lost one. Denials must be
    // written down.
    const event = screenRead({
      principal: { ...alice, audience: "external" },
      satelliteId: "orders",
      screenId: "orders.list",
      params: {},
      outcome: { status: "denied", httpStatus: 403, reason: "audience not permitted" },
      latencyMs: 1,
      at: "2026-08-16T10:00:00.000Z",
      id: "evt_7",
    });
    expect(() => AuditEventSchema.parse(event)).not.toThrow();
    expect(event.outcome.status).toBe("denied");
  });
});
