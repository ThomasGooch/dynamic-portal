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
  it("round-trips", () => {
    expect(verifyPrincipal(signPrincipal(alice, SECRET), SECRET)).toEqual(alice);
  });

  it("rejects a token signed with a different secret", () => {
    expect(() =>
      verifyPrincipal(signPrincipal({ ...alice, tenantId: "evil" }, "other"), SECRET),
    ).toThrow(InvalidPrincipalError);
  });

  it("rejects a tampered payload", () => {
    const signature = signPrincipal(alice, SECRET).split(".")[1];
    const swapped = Buffer.from(
      JSON.stringify({ ...alice, tenantId: "globex" }),
      "utf8",
    ).toString("base64url");
    expect(() => verifyPrincipal(`${swapped}.${signature}`, SECRET)).toThrow(
      InvalidPrincipalError,
    );
  });

  it.each(["", "no-dot", "a.b.c", "....", ".", "x.", "!!!.???"])(
    "rejects malformed token %j",
    (bad) => {
      expect(() => verifyPrincipal(bad, SECRET)).toThrow(InvalidPrincipalError);
    },
  );

  // The Python satellite had exactly this hole: a non-ASCII header byte raised
  // an encoding error rather than an InvalidPrincipalError, so it escaped the
  // auth layer as an unauthenticated 500. Asserting the same property here so
  // the two implementations cannot diverge on it again.
  it.each(["é.abc", "abc.é", "éé.éé", "🙂.x"])(
    "rejects non-ASCII token %j as invalid rather than crashing",
    (bad) => {
      expect(() => verifyPrincipal(bad, SECRET)).toThrow(InvalidPrincipalError);
    },
  );

  it("rejects a correctly signed token carrying unknown claims", () => {
    // Strict, to match the Python implementation. A token that authenticates
    // against one satellite and is refused by another is one identity with two
    // answers — worse than either consistent outcome.
    const payload = Buffer.from(
      JSON.stringify({ ...alice, isAdmin: true }),
      "utf8",
    ).toString("base64url");
    const token = signPrincipal(alice, SECRET);
    const badToken = `${payload}.${token.split(".")[1]}`;
    expect(() => verifyPrincipal(badToken, SECRET)).toThrow(InvalidPrincipalError);
  });

  it("rejects a correctly signed token that is not a principal", () => {
    const payload = Buffer.from(JSON.stringify({ nope: 1 }), "utf8").toString("base64url");
    expect(() =>
      verifyPrincipal(`${payload}.${signPrincipal(alice, SECRET).split(".")[1]}`, SECRET),
    ).toThrow(InvalidPrincipalError);
  });

  describe("cross-language contract", () => {
    // Minted by the Python satellite under the secret below. If either side
    // changes the wire format this fails, rather than the two quietly ceasing
    // to speak the same protocol.
    const SHARED_SECRET = "cross-language-fixture";
    const PYTHON_TOKEN =
      "eyJzdWIiOiJkYW5hQGFjbWUuZXhhbXBsZSIsInRlbmFudElkIjoiYWNtZSIsImF1ZGllbmNlIjoiaW50ZXJuYWwiLCJzY29wZXMiOlsiZmxlZXQucmVhZCJdfQ" +
      ".rSTY_1hMvKQ4VQkFl21Ei26LRebW6RbGcxYaz5Bd2iU";

    it("verifies a token the Python satellite would accept", () => {
      const principal = verifyPrincipal(PYTHON_TOKEN, SHARED_SECRET);
      expect(principal.tenantId).toBe("acme");
      expect(principal.scopes).toEqual(["fleet.read"]);
    });

    it("still refuses it under a different secret", () => {
      expect(() => verifyPrincipal(PYTHON_TOKEN, "other")).toThrow(InvalidPrincipalError);
    });
  });
});
