import { describe, expect, it } from "vitest";
import {
  COMPONENT_NAMES,
  CATALOG_VERSION,
  isComponentName,
  propsSchemaFor,
} from "./components.js";

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
    it("uses no string-length constraints", () => {
      for (const name of COMPONENT_NAMES) {
        const json = JSON.stringify(propsSchemaFor(name)!._def);
        expect(json, `${name} uses a length/range check`).not.toMatch(
          /"kind":"(min|max|length)"/,
        );
      }
    });
  });
});
