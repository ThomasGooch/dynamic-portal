import { describe, expect, it } from "vitest";
import {
  CURRENT_PROTOCOL_VERSION,
  MAJOR_SUPPORT_WINDOW,
  isMajorWithinSupportWindow,
  isSupportedProtocolVersion,
  parseProtocolVersion,
} from "./version.js";

describe("protocol version", () => {
  it("exposes a current version as MAJOR.MINOR", () => {
    expect(CURRENT_PROTOCOL_VERSION).toMatch(/^\d+\.\d+$/);
  });

  it("parses a well-formed version", () => {
    expect(parseProtocolVersion("2.7")).toEqual({ major: 2, minor: 7 });
  });

  it.each(["1", "1.2.3", "v1.0", "", "a.b", "1.", "-1.0", "1.-2", " 1.0"])(
    "rejects malformed version %j",
    (bad) => {
      expect(() => parseProtocolVersion(bad)).toThrow();
    },
  );
});

describe("support window policy", () => {
  // Policy is tested independently of the current version so the rule stays
  // verifiable as CURRENT_PROTOCOL_VERSION advances. The hub supports the
  // current major and the MAJOR_SUPPORT_WINDOW majors preceding it.
  it("is a two-major window (N-2)", () => {
    expect(MAJOR_SUPPORT_WINDOW).toBe(2);
  });

  it("accepts the current major", () => {
    expect(isMajorWithinSupportWindow(5, 5)).toBe(true);
  });

  it("accepts the two preceding majors", () => {
    expect(isMajorWithinSupportWindow(4, 5)).toBe(true);
    expect(isMajorWithinSupportWindow(3, 5)).toBe(true);
  });

  it("rejects a major older than the window", () => {
    expect(isMajorWithinSupportWindow(2, 5)).toBe(false);
  });

  it("rejects a future major the hub cannot know how to render", () => {
    expect(isMajorWithinSupportWindow(6, 5)).toBe(false);
  });
});

describe("isSupportedProtocolVersion", () => {
  const { major } = parseProtocolVersion(CURRENT_PROTOCOL_VERSION);

  it("accepts the current version", () => {
    expect(isSupportedProtocolVersion(CURRENT_PROTOCOL_VERSION)).toBe(true);
  });

  it("accepts any minor within the current major", () => {
    // Within a major the catalog is additive-only, so a newer minor may use
    // components this hub will degrade — documented behavior, not an error.
    expect(isSupportedProtocolVersion(`${major}.0`)).toBe(true);
    expect(isSupportedProtocolVersion(`${major}.99`)).toBe(true);
  });

  it("rejects the next major", () => {
    expect(isSupportedProtocolVersion(`${major + 1}.0`)).toBe(false);
  });

  it("rejects a major far ahead of this hub", () => {
    expect(isSupportedProtocolVersion(`${major + MAJOR_SUPPORT_WINDOW + 1}.0`)).toBe(false);
  });

  it("rejects a major that has aged out of the window", () => {
    // Expressed through the policy function: while CURRENT_PROTOCOL_VERSION is
    // still 1.x there is no *string* older than the window to feed the total
    // function, so asserting on it here would only re-test the future edge.
    expect(isMajorWithinSupportWindow(major - MAJOR_SUPPORT_WINDOW - 1, major)).toBe(false);
  });

  it("returns false rather than throwing on malformed input", () => {
    expect(isSupportedProtocolVersion("not-a-version")).toBe(false);
  });
});
