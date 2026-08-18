import { describe, expect, it } from "vitest";
import { checkArguments } from "./invoke";

/**
 * The list type, checked at the door.
 *
 * `typeof [] === "object"`, so the ordinary type check could never have
 * distinguished a list from any other object — which is why this needs its own
 * branch and its own tests rather than riding on the existing ones.
 */
const schema = {
  type: "object" as const,
  properties: {
    tags: {
      type: "array" as const,
      items: { type: "string" as const, enum: ["retail", "hazmat"] as const },
    },
    plain: { type: "array" as const, items: { type: "string" as const } },
  },
  required: [] as string[],
  additionalProperties: false as const,
};

const check = (args: Record<string, unknown>) => checkArguments(schema, args, "write");

describe("a list argument", () => {
  it("accepts a list of allowed values", () => {
    const result = check({ tags: ["retail", "hazmat"] });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value["tags"]).toEqual(["retail", "hazmat"]);
  });

  it("accepts an empty list, which is a real answer", () => {
    // "No labels" is a thing a caller can mean, and refusing it would make
    // clearing them impossible.
    expect(check({ tags: [] }).ok).toBe(true);
  });

  it("refuses an object pretending to be a list", () => {
    // The failure the array branch exists for: `typeof {} === "object"` too.
    expect(check({ tags: {} }).ok).toBe(false);
    expect(check({ tags: "retail" }).ok).toBe(false);
  });

  it("refuses a list with a non-string in it", () => {
    // Keeping the good entries would change what the caller asked for.
    const result = check({ plain: ["retail", 7] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/list of text/i);
  });

  it("refuses a value outside the choices, naming them", () => {
    const result = check({ tags: ["retail", "explosives"] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/retail, hazmat/);
  });

  it("copies the list rather than passing the caller's array through", () => {
    const args = { plain: ["retail"] };
    const result = check(args);
    expect(result.ok && result.value["plain"]).not.toBe(args.plain);
  });
});
