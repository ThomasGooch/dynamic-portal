import { describe, expect, it } from "vitest";
import { principalFromClaims } from "./oidc";

// Claim shapes taken from a real Keycloak token (verified against the committed
// realm): roles arrive in the access token's realm_access.roles, tenant_id from
// the user-attribute mapper.
const idClaims = {
  sub: "ac977b5e-1234",
  preferred_username: "fin",
  email: "fin@acme.example",
  tenant_id: "acme",
};

describe("principalFromClaims", () => {
  it("maps a Keycloak token into a Principal", () => {
    const p = principalFromClaims(idClaims, ["finance"]);
    expect(p.sub).toBe("ac977b5e-1234");
    expect(p.tenantId).toBe("acme");
    expect(p.audience).toBe("internal");
    expect(p.roles).toEqual(["finance"]);
    expect(p.scopes).toContain("orders.read");
  });

  it("filters Keycloak built-in realm roles down to the four we understand", () => {
    const p = principalFromClaims(idClaims, [
      "offline_access",
      "finance",
      "uma_authorization",
      "default-roles-portal",
    ]);
    expect(p.roles).toEqual(["finance"]);
  });

  it("omits roles entirely when none are recognised (un-role-gated, not nobody)", () => {
    const p = principalFromClaims(idClaims, ["offline_access"]);
    expect(p.roles).toBeUndefined();
  });

  it("falls back to preferred_username then email for the subject", () => {
    expect(principalFromClaims({ preferred_username: "fin", tenant_id: "acme" }, []).sub).toBe("fin");
    expect(principalFromClaims({ email: "fin@acme.example", tenant_id: "acme" }, []).sub).toBe(
      "fin@acme.example",
    );
  });

  it("stays internal unless portal_audience is exactly external", () => {
    expect(principalFromClaims({ ...idClaims, portal_audience: "external" }, []).audience).toBe(
      "external",
    );
    expect(principalFromClaims({ ...idClaims, portal_audience: "partner" }, []).audience).toBe(
      "internal",
    );
  });

  it("refuses a tenantless token — isolation must not depend on a default", () => {
    expect(() => principalFromClaims({ sub: "x" }, ["finance"])).toThrow(/tenant/i);
  });

  it("refuses a token with no usable subject", () => {
    expect(() => principalFromClaims({ tenant_id: "acme" }, [])).toThrow(/subject/i);
  });
});
