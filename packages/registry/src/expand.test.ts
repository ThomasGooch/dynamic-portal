import { describe, expect, it } from "vitest";
import { UnresolvedVariableError, expandEnv } from "./expand";

describe("expandEnv", () => {
  const env = { ORDERS_URL: "http://satellite-orders:4001", EMPTY: "" };

  it("substitutes a set variable", () => {
    expect(expandEnv("baseUrl: ${ORDERS_URL}", env)).toBe(
      "baseUrl: http://satellite-orders:4001",
    );
  });

  it("uses the default when a variable is unset", () => {
    expect(expandEnv("baseUrl: ${NOPE:-http://localhost:4001}", env)).toBe(
      "baseUrl: http://localhost:4001",
    );
  });

  it("prefers the set variable over the default", () => {
    expect(expandEnv("${ORDERS_URL:-http://localhost:4001}", env)).toBe(
      "http://satellite-orders:4001",
    );
  });

  it("treats a variable set to empty as set, not missing", () => {
    // Compose writes an empty string for a declared-but-unset variable. Falling
    // back to the default there would silently ignore an operator's explicit
    // decision to blank something out.
    expect(expandEnv("[${EMPTY:-fallback}]", env)).toBe("[]");
  });

  it("throws rather than substituting nothing for an unset variable", () => {
    // An empty substitution yields `baseUrl: ` — valid YAML, a null value, and
    // a schema error three layers away from the actual mistake. Failing here
    // names the variable.
    expect(() => expandEnv("baseUrl: ${MISSING}", env)).toThrow(UnresolvedVariableError);
    expect(() => expandEnv("baseUrl: ${MISSING}", env)).toThrow(/MISSING/);
  });

  it("expands several variables in one document", () => {
    expect(expandEnv("${ORDERS_URL} and ${NOPE:-x}", env)).toBe(
      "http://satellite-orders:4001 and x",
    );
  });

  it("leaves text that merely looks similar alone", () => {
    expect(expandEnv("a $ORDERS_URL b {ORDERS_URL} c", env)).toBe(
      "a $ORDERS_URL b {ORDERS_URL} c",
    );
  });

  it("does not re-expand a substituted value", () => {
    // Otherwise a variable whose value contains `${...}` becomes an injection
    // point for whatever set it.
    expect(expandEnv("${TRICK}", { TRICK: "${ORDERS_URL}" })).toBe("${ORDERS_URL}");
  });

  it("allows a default containing a colon, as URLs do", () => {
    expect(expandEnv("${NOPE:-http://host:1234/x}", env)).toBe("http://host:1234/x");
  });

  it("allows an empty default", () => {
    expect(expandEnv("[${NOPE:-}]", env)).toBe("[]");
  });
});
