import { describe, expect, it } from "vitest";
import {
  InvalidPrincipalError,
  signPrincipal,
  verifyPrincipal,
  type Principal,
} from "./principal.js";

const SECRET = "test-secret";
const alice: Principal = {
  sub: "alice@acme.example",
  tenantId: "acme",
  audience: "internal",
  scopes: ["orders.read", "orders.write"],
};

describe("principal token", () => {
  it("round-trips a principal", () => {
    expect(verifyPrincipal(signPrincipal(alice, SECRET), SECRET)).toEqual(alice);
  });

  // The architecture's central security claim is that a satellite authorizes
  // independently rather than trusting the hub. That is only true if the
  // satellite *verifies* the identity it is handed — these tests are what make
  // the claim real instead of decorative.
  it("rejects a token signed with a different secret", () => {
    const forged = signPrincipal({ ...alice, tenantId: "evil" }, "not-the-secret");
    expect(() => verifyPrincipal(forged, SECRET)).toThrow(InvalidPrincipalError);
  });

  it("rejects a tampered payload", () => {
    const token = signPrincipal(alice, SECRET);
    const [payload, signature] = token.split(".");
    const swapped = Buffer.from(
      JSON.stringify({ ...alice, tenantId: "globex" }),
      "utf8",
    ).toString("base64url");
    expect(payload).toBeDefined();
    expect(() => verifyPrincipal(`${swapped}.${signature}`, SECRET)).toThrow(
      InvalidPrincipalError,
    );
  });

  it.each(["", "no-dot", "a.b.c", "....", "!!!.???"])(
    "rejects malformed token %j",
    (bad) => {
      expect(() => verifyPrincipal(bad, SECRET)).toThrow(InvalidPrincipalError);
    },
  );

  it("rejects a structurally valid token carrying a nonsense principal", () => {
    const payload = Buffer.from(JSON.stringify({ nope: true }), "utf8").toString(
      "base64url",
    );
    // Sign the junk correctly so only the *shape* check can reject it.
    const token = signPrincipal(alice, SECRET);
    const signature = token.split(".")[1];
    expect(() => verifyPrincipal(`${payload}.${signature}`, SECRET)).toThrow(
      InvalidPrincipalError,
    );
  });
});
