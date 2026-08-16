import { describe, expect, it } from "vitest";
import { formatValue } from "./format";

describe("formatValue", () => {
  it("renders a string as itself", () => {
    expect(formatValue("hello", undefined)).toBe("hello");
  });

  it("renders a number without inventing precision", () => {
    expect(formatValue(1234.5, undefined)).toBe("1,234.5");
    expect(formatValue(42, undefined)).toBe("42");
  });

  it("renders booleans as words rather than as nothing", () => {
    // `String(false)` inside JSX renders an empty cell, which reads as missing
    // data rather than as a false value.
    expect(formatValue(true, undefined)).toBe("Yes");
    expect(formatValue(false, undefined)).toBe("No");
  });

  it("renders null and undefined as an em dash, not the words", () => {
    expect(formatValue(null, undefined)).toBe("—");
    expect(formatValue(undefined, undefined)).toBe("—");
  });

  it("never renders an object as [object Object]", () => {
    // Row cells are satellite *data*, so a nested object is entirely possible.
    // The failure mode to avoid is a cell that looks like a bug in the hub.
    expect(formatValue({ a: 1 }, undefined)).toBe('{"a":1}');
    expect(formatValue([1, 2], undefined)).toBe("[1,2]");
  });

  it("renders a bigint as its digits rather than throwing", () => {
    // JSON.stringify throws on a BigInt, so the fallback path would swallow an
    // id that arrived as one.
    expect(formatValue(9007199254740993n, undefined)).toBe("9007199254740993");
  });

  it("renders a non-finite number as blank rather than as NaN", () => {
    expect(formatValue(Number.NaN, undefined)).toBe("—");
    expect(formatValue(Number.POSITIVE_INFINITY, undefined)).toBe("—");
  });

  it("survives a value that cannot be serialised at all", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(formatValue(cyclic, undefined)).toBe("—");
  });

  describe("money", () => {
    it("always shows two decimal places", () => {
      expect(formatValue(1234.5, "money")).toBe("1,234.50");
      expect(formatValue(3, "money")).toBe("3.00");
    });

    it("leaves a non-number alone rather than coercing it", () => {
      // A satellite that sends "1.2.3" gets its own string back, not NaN.
      expect(formatValue("1.2.3", "money")).toBe("1.2.3");
    });
  });

  describe("date and datetime", () => {
    it("formats an ISO instant identically regardless of the ambient timezone", () => {
      // The same tree renders on the server and again in the browser. Anything
      // that reads the ambient locale or zone produces two different strings
      // and React reports a hydration mismatch — on a machine in UTC, never.
      expect(formatValue("2026-03-04T22:30:00Z", "date")).toBe("2026-03-04");
      expect(formatValue("2026-03-04T22:30:00Z", "datetime")).toBe("2026-03-04 22:30 UTC");
    });

    it("formats an epoch number too", () => {
      expect(formatValue(1772665800000, "date")).toBe("2026-03-04");
    });

    it("hands back anything it cannot parse, rather than showing Invalid Date", () => {
      expect(formatValue("not a date", "date")).toBe("not a date");
      expect(formatValue("", "date")).toBe("—");
    });
  });

  it("passes code through unchanged so whitespace survives", () => {
    expect(formatValue("  a  b ", "code")).toBe("  a  b ");
  });

  it("stringifies a badge value like text, since the tone is carried separately", () => {
    expect(formatValue(7, "badge")).toBe("7");
  });
});
