import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  COMPONENT_NAMES,
  CATALOG_VERSION,
  isComponentName,
  propsSchemaFor,
} from "./components";

describe("the catalog", () => {
  it("declares 34 components", () => {
    expect(COMPONENT_NAMES).toHaveLength(34);
  });

  it("has no duplicate names", () => {
    expect(new Set(COMPONENT_NAMES).size).toBe(COMPONENT_NAMES.length);
  });

  it("covers the four documented groups", () => {
    // Guards against a component being added to the type union but forgotten in
    // the schema map, which would surface as a runtime "unknown component"
    // rather than a compile error.
    for (const name of COMPONENT_NAMES) {
      expect(propsSchemaFor(name), `${name} has no props schema`).toBeDefined();
    }
  });

  it("is versioned, so a satellite can reason about what it may use", () => {
    expect(CATALOG_VERSION).toMatch(/^\d+\.\d+$/);
  });

  it("recognises its own names and nothing else", () => {
    expect(isComponentName("Table")).toBe(true);
    expect(isComponentName("Script")).toBe(false);
    expect(isComponentName("table")).toBe(false);
  });
});

describe("prop schemas", () => {
  it("accepts a well-formed Table", () => {
    expect(() =>
      propsSchemaFor("Table")!.parse({
        columns: [{ key: "id", label: "Order" }],
        rows: [{ id: "1" }],
      }),
    ).not.toThrow();
  });

  it("rejects a Table with no columns declared", () => {
    expect(() => propsSchemaFor("Table")!.parse({ rows: [] })).toThrow();
  });

  it("accepts a Button carrying an action", () => {
    expect(() =>
      propsSchemaFor("Button")!.parse({
        label: "Approve",
        variant: "primary",
        action: { actionId: "orders.approve", payload: { id: "1" } },
      }),
    ).not.toThrow();
  });

  it("accepts an http(s) Link but refuses a script-bearing scheme", () => {
    // z.string().url() is new URL() underneath, which happily accepts
    // javascript: and data: — a satellite-supplied Link that runs script when
    // a user clicks it.
    expect(() => propsSchemaFor("Link")!.parse({ label: "Docs", href: "https://a.example" }))
      .not.toThrow();
    for (const href of ["javascript:alert(1)", "data:text/html,<script>x</script>", "/relative"]) {
      expect(() => propsSchemaFor("Link")!.parse({ label: "Go", href })).toThrow();
    }
  });

  it("rejects an unknown Button variant", () => {
    expect(() =>
      propsSchemaFor("Button")!.parse({ label: "Go", variant: "sparkly" }),
    ).toThrow();
  });

  describe("the styling boundary", () => {
    // The protocol rejects these at the top level of a node; the catalog is the
    // layer that knows a component's full prop surface, so it is where the
    // guarantee has to hold for every component rather than a sample.
    it.each(COMPONENT_NAMES)("rejects a style escape hatch on %s", (name) => {
      const schema = propsSchemaFor(name)!;
      for (const forbidden of ["className", "style", "css", "dangerouslySetInnerHTML"]) {
        expect(
          () => schema.parse({ [forbidden]: "x" }),
          `${name} accepted ${forbidden}`,
        ).toThrow();
      }
    });

    it.each(COMPONENT_NAMES)("rejects unknown props on %s", (name) => {
      expect(() => propsSchemaFor(name)!.parse({ notARealProp: 1 })).toThrow();
    });
  });

  describe("structured-output compatibility", () => {
    // The agent emits screens through a tool whose input_schema is this
    // catalog, and structured outputs reject `minLength`/`maximum`-style
    // keywords. Prop schemas therefore express requiredness and enums but never
    // string length or numeric range — one definition serves both producers.
    // `JSON.stringify(schema._def)` cannot be used for this: a ZodObject holds
    // its shape behind a function, which stringify drops, so the serialised
    // `_def` is identical for `z.object({ a: z.string() })` and
    // `z.object({ a: z.string().min(1) })`. The walk below reaches the leaves.
    const checkKinds = (schema: unknown, seen = new Set<unknown>()): string[] => {
      if (typeof schema !== "object" || schema === null || seen.has(schema)) return [];
      seen.add(schema);
      const def = (schema as { _def?: Record<string, unknown> })._def;
      if (def === undefined) return [];

      const kinds: string[] = [];
      for (const check of (def["checks"] as { kind?: string }[] | undefined) ?? []) {
        if (check.kind !== undefined) kinds.push(check.kind);
      }
      const shape = def["shape"];
      const fields = typeof shape === "function" ? (shape as () => unknown)() : shape;
      for (const field of Object.values((fields ?? {}) as Record<string, unknown>)) {
        kinds.push(...checkKinds(field, seen));
      }
      // The wrappers a prop schema can be built from: optional/array/record/
      // effects/union all park their inner schema under one of these keys.
      for (const key of ["type", "innerType", "schema", "valueType", "keyType", "element"]) {
        kinds.push(...checkKinds(def[key], seen));
      }
      for (const option of (def["options"] as unknown[] | undefined) ?? []) {
        kinds.push(...checkKinds(option, seen));
      }
      return kinds;
    };

    it("the walk actually reaches nested leaves", () => {
      // Without this the assertion below could pass by never looking at
      // anything, which is how the first version of it was wrong.
      const probe = z.object({ a: z.array(z.object({ b: z.string().min(1) })) }).strict();
      expect(checkKinds(probe)).toContain("min");
    });

    it("uses no string-length or numeric-range constraints", () => {
      for (const name of COMPONENT_NAMES) {
        const kinds = checkKinds(propsSchemaFor(name)!);
        for (const forbidden of ["min", "max", "length"]) {
          expect(kinds, `${name} uses a ${forbidden} check`).not.toContain(forbidden);
        }
      }
    });
  });
});
