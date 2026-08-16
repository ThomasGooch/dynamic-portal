import { describe, expect, it } from "vitest";
import type { UiNode } from "@portal/protocol";
import { validateNested } from "./nested.js";
import { FlatSpecSchema } from "./flat.js";
import {
  GENERATED_ID_PREFIX,
  ReservedNodeIdError,
  flatToKeyed,
  keyedToNested,
  nestedToFlat,
  nestedToKeyed,
} from "./adapters.js";

const screen: UiNode = {
  type: "Page",
  children: [
    {
      type: "Section",
      props: { title: "Orders" },
      children: [
        {
          type: "Table",
          id: "orders-table",
          props: { columns: [{ key: "id", label: "Order" }], rows: [{ id: "1" }] },
        },
      ],
    },
  ],
};

describe("nested validation (what satellites emit)", () => {
  it("accepts a well-formed tree", () => {
    expect(validateNested(screen).ok).toBe(true);
  });

  it("rejects an unknown component anywhere in the tree", () => {
    const bad: UiNode = { type: "Page", children: [{ type: "Script" }] };
    const result = validateNested(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toMatch(/Script/);
  });

  it("reports the path to a bad node, not just that one exists", () => {
    // A satellite author with fifty nodes needs to know which one is wrong.
    const bad: UiNode = {
      type: "Page",
      children: [{ type: "Section", children: [{ type: "Button", props: {} }] }],
    };
    const result = validateNested(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toContain("children");
  });

  it("rejects bad props deep in the tree, not only at the root", () => {
    const bad: UiNode = {
      type: "Page",
      children: [{ type: "Badge", props: { label: "x", tone: "chartreuse" } }],
    };
    expect(validateNested(bad).ok).toBe(false);
  });
});

describe("flat shape (what the agent emits)", () => {
  const flat = {
    root: "n0",
    elements: [
      { id: "n0", type: "Page", props: {}, children: ["n1"] },
      { id: "n1", type: "Heading", props: { text: "Hi" }, children: [] },
    ],
  };

  it("accepts a well-formed spec", () => {
    expect(() => FlatSpecSchema.parse(flat)).not.toThrow();
  });

  it("is a list, not a keyed map", () => {
    // A map with arbitrary keys cannot be strict-schema-constrained: structured
    // outputs require additionalProperties:false everywhere and do not accept
    // additionalProperties-as-schema. This is the whole reason the agent shape
    // differs from the renderer's.
    expect(Array.isArray(FlatSpecSchema.parse(flat).elements)).toBe(true);
  });

  it("rejects a root that names no element", () => {
    expect(() => FlatSpecSchema.parse({ ...flat, root: "nope" })).toThrow();
  });

  it("rejects a child reference that names no element", () => {
    expect(() =>
      FlatSpecSchema.parse({
        root: "n0",
        elements: [{ id: "n0", type: "Page", props: {}, children: ["ghost"] }],
      }),
    ).toThrow();
  });

  it("rejects duplicate element ids", () => {
    expect(() =>
      FlatSpecSchema.parse({
        root: "n0",
        elements: [
          { id: "n0", type: "Page", props: {}, children: [] },
          { id: "n0", type: "Text", props: { text: "x" }, children: [] },
        ],
      }),
    ).toThrow();
  });

  it("rejects a cycle rather than hanging on it", () => {
    expect(() =>
      FlatSpecSchema.parse({
        root: "a",
        elements: [
          { id: "a", type: "Stack", props: {}, children: ["b"] },
          { id: "b", type: "Stack", props: {}, children: ["a"] },
        ],
      }),
    ).toThrow();
  });

  it("has no recursive schema, so depth costs nothing to validate", () => {
    const deep = {
      root: "n0",
      elements: Array.from({ length: 5000 }, (_, i) => ({
        id: `n${i}`,
        type: "Stack" as const,
        props: {},
        children: i < 4999 ? [`n${i + 1}`] : [],
      })),
    };
    // The nested schema would blow the stack here; the flat one must not.
    expect(() => FlatSpecSchema.parse(deep)).not.toThrow();
  });
});

describe("adapters", () => {
  it("nested → flat → keyed → nested round-trips", () => {
    const flat = nestedToFlat(screen);
    const keyed = flatToKeyed(flat);
    expect(keyedToNested(keyed)).toEqual(screen);
  });

  it("nested → keyed produces json-render's native shape", () => {
    const keyed = nestedToKeyed(screen);
    expect(typeof keyed.elements).toBe("object");
    expect(Array.isArray(keyed.elements)).toBe(false);
    expect(keyed.elements[keyed.root]?.type).toBe("Page");
  });

  it("preserves author-supplied ids, because patches address them", () => {
    const flat = nestedToFlat(screen);
    expect(flat.elements.map((e) => e.id)).toContain("orders-table");
  });

  it("generates stable ids for unnamed nodes", () => {
    expect(nestedToFlat(screen).elements.map((e) => e.id)).toEqual(
      nestedToFlat(screen).elements.map((e) => e.id),
    );
  });

  it("marks generated ids so the round trip can tell them from authored ones", () => {
    // Without this the conversion is quietly lossy: rebuilding either drops the
    // author's ids — breaking patch targeting — or invents ids for nodes that
    // never had one.
    const flat = nestedToFlat(screen);
    const generated = flat.elements.filter((e) => e.id.startsWith(GENERATED_ID_PREFIX));
    expect(generated.length).toBeGreaterThan(0);
    expect(flat.elements.some((e) => e.id === "orders-table")).toBe(true);
  });

  it("refuses an author id that would forge the generated marker", () => {
    expect(() =>
      nestedToFlat({ type: "Page", id: `${GENERATED_ID_PREFIX}0` }),
    ).toThrow(ReservedNodeIdError);
  });

  it("drops generated ids when rebuilding, and keeps authored ones", () => {
    const rebuilt = keyedToNested(nestedToKeyed(screen));
    expect(rebuilt.id).toBeUndefined();
    const table = rebuilt.children?.[0]?.children?.[0];
    expect(table?.id).toBe("orders-table");
  });

  it("a flat spec produced from a valid tree validates", () => {
    expect(() => FlatSpecSchema.parse(nestedToFlat(screen))).not.toThrow();
  });

  it("emits a reused node object once, not twice under one id", () => {
    // An author reusing a constant for two slots is ordinary JavaScript. Giving
    // the shared object an id per visit puts two elements with the same id in
    // the list, which FlatSpecSchema then rejects — the adapter would be
    // producing specs its own validator calls malformed.
    const shared: UiNode = { type: "Divider" };
    const flat = nestedToFlat({ type: "Page", children: [shared, shared] });
    expect(new Set(flat.elements.map((e) => e.id)).size).toBe(flat.elements.length);
    expect(() => FlatSpecSchema.parse(flat)).not.toThrow();
  });

  it("converts a tree far deeper than the stack, in both directions", () => {
    // The flat shape deliberately permits depth the nested schema cannot, so a
    // recursive adapter would overflow on a spec this package calls valid.
    let node: UiNode = { type: "Text", props: { text: "leaf" } };
    for (let i = 0; i < 20_000; i += 1) node = { type: "Stack", children: [node] };

    const keyed = nestedToKeyed(node);
    let depth = 0;
    for (let cursor = keyedToNested(keyed); cursor.children?.[0]; cursor = cursor.children[0]) {
      depth += 1;
    }
    expect(depth).toBe(20_000);
  });

  it("keeps an element whose id collides with an Object.prototype key", () => {
    // Ids come from satellites and agents. `elements["__proto__"] = …` on an
    // object literal invokes the prototype setter, so the element disappears
    // from Object.keys and the renderer draws nothing for it.
    const keyed = flatToKeyed({
      root: "__proto__",
      elements: [{ id: "__proto__", type: "Page", children: [] }],
    });
    expect(Object.keys(keyed.elements)).toEqual(["__proto__"]);
    expect(keyedToNested(keyed).type).toBe("Page");
  });

  it("rejects an id that only resolves through the prototype chain", () => {
    expect(() =>
      keyedToNested({ root: "constructor", elements: {} }),
    ).toThrow(/not found/);
  });
});
