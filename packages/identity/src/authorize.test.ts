import { describe, expect, it } from "vitest";
import { authorize } from "./authorize.js";
import type { Principal } from "./principal.js";

const alice: Principal = {
  sub: "alice@acme.example",
  tenantId: "acme",
  audience: "internal",
  scopes: ["orders.read"],
};

const target = { audience: ["internal"] as const, rbacScopes: ["orders.read"] };

describe("authorize", () => {
  it("allows a principal whose audience and scopes match", () => {
    expect(authorize(alice, target)).toEqual({ allowed: true });
  });

  describe("audience", () => {
    it("refuses an audience the target does not declare", () => {
      const result = authorize({ ...alice, audience: "external" }, target);
      expect(result).toEqual({
        allowed: false,
        status: 403,
        reason: "audience not permitted",
      });
    });

    it("allows external where the target declares it", () => {
      expect(
        authorize({ ...alice, audience: "external" }, {
          audience: ["internal", "external"],
          rbacScopes: ["orders.read"],
        }),
      ).toEqual({ allowed: true });
    });

    it("refuses when the target declares no audience at all", () => {
      // Default-deny has to survive the degenerate case: an empty list means
      // nobody, not everybody.
      expect(authorize(alice, { audience: [], rbacScopes: [] }).allowed).toBe(false);
    });
  });

  describe("scopes", () => {
    it("refuses a principal missing a required scope", () => {
      const result = authorize({ ...alice, scopes: [] }, target);
      expect(result).toEqual({
        allowed: false,
        status: 403,
        reason: "missing scope orders.read",
      });
    });

    it("requires every declared scope, not any of them", () => {
      const result = authorize(alice, {
        audience: ["internal"],
        rbacScopes: ["orders.read", "orders.write"],
      });
      expect(result.allowed).toBe(false);
    });

    it("allows when the target requires no scopes", () => {
      expect(authorize({ ...alice, scopes: [] }, { audience: ["internal"], rbacScopes: [] }))
        .toEqual({ allowed: true });
    });
  });

  it("checks audience before scopes, so a wrong-audience caller learns nothing about scopes", () => {
    const result = authorize({ ...alice, audience: "external", scopes: [] }, target);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("audience not permitted");
  });
});
