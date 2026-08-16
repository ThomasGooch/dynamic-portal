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

  it("distinguishes a missing key from an undefined one", () => {
    expect(canonicalDigest({ a: 1 })).not.toBe(canonicalDigest({ a: 1, b: null }));
  });

  it("does not preserve array order-insensitivity — order is meaning", () => {
    expect(canonicalDigest([1, 2])).not.toBe(canonicalDigest([2, 1]));
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
