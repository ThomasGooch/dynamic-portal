import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "@portal/identity";
import { isAgentAllowedForTenant, isAgentEnabled } from "./agent";

/**
 * The consent gate, tested where it is decided.
 *
 * `PORTAL_AGENT_DISABLED_TENANTS` is a compliance control rather than a feature
 * flag — PLAN.md treats a tenant declining AI processing as a contractual
 * position, not a preference. It is asserted here rather than end to end
 * because a container runs as one tenant, so an e2e test could only ever
 * exercise the allowed path and would assert nothing about the denied one.
 */

const principal = (tenantId: string): Principal => ({
  sub: `someone@${tenantId}.example`,
  tenantId,
  audience: "internal",
  scopes: [],
});

const original = { ...process.env };

beforeEach(() => {
  delete process.env["PORTAL_AGENT"];
  delete process.env["PORTAL_AGENT_DISABLED_TENANTS"];
  delete process.env["ANTHROPIC_API_KEY"];
});

afterEach(() => {
  process.env = { ...original };
});

describe("tenant consent", () => {
  it("allows a tenant nobody disabled", () => {
    expect(isAgentAllowedForTenant(principal("acme"))).toBe(true);
  });

  it("refuses a tenant that withdrew consent", () => {
    process.env["PORTAL_AGENT_DISABLED_TENANTS"] = "withdrawn";
    expect(isAgentAllowedForTenant(principal("withdrawn"))).toBe(false);
    expect(isAgentAllowedForTenant(principal("acme"))).toBe(true);
  });

  it("reads a list, and tolerates the spacing a human will use", () => {
    process.env["PORTAL_AGENT_DISABLED_TENANTS"] = " withdrawn , other ";
    expect(isAgentAllowedForTenant(principal("withdrawn"))).toBe(false);
    expect(isAgentAllowedForTenant(principal("other"))).toBe(false);
  });

  it("refuses everyone when the agent is switched off globally", () => {
    process.env["PORTAL_AGENT"] = "off";
    expect(isAgentAllowedForTenant(principal("acme"))).toBe(false);
  });

  it("does not depend on our own model being configured", () => {
    // The distinction that let the outward MCP endpoint slip past this control:
    // it needs no key of ours, because the model belongs to whoever connects.
    // Consent governs the surface, not whose model reaches it.
    expect(process.env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(isAgentAllowedForTenant(principal("acme"))).toBe(true);
  });
});

describe("the in-hub assistant", () => {
  it("stays off without a key, whatever the tenant agreed to", () => {
    expect(isAgentEnabled(principal("acme"))).toBe(false);
  });

  it("turns on for a consenting tenant once a key exists", () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    expect(isAgentEnabled(principal("acme"))).toBe(true);
  });

  it("stays off for a tenant that withdrew, key or no key", () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["PORTAL_AGENT_DISABLED_TENANTS"] = "withdrawn";
    expect(isAgentEnabled(principal("withdrawn"))).toBe(false);
  });
});
