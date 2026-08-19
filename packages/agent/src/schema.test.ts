import { COMPONENT_NAMES } from "@portal/catalog";
import { describe, expect, it } from "vitest";
import { AUTHORED_BY_TOOLS, RENDER_SCREEN_SCHEMA, renderScreenSchema } from "./schema";

/** Every object node anywhere in a JSON Schema, with the path that reached it. */
function objectNodes(schema: unknown): { path: string; node: Record<string, unknown> }[] {
  const found: { path: string; node: Record<string, unknown> }[] = [];
  const stack: { value: unknown; path: string }[] = [{ value: schema, path: "" }];

  while (stack.length > 0) {
    const { value, path } = stack.pop() as { value: unknown; path: string };
    if (typeof value !== "object" || value === null) continue;
    const node = value as Record<string, unknown>;
    if (node["type"] === "object") found.push({ path, node });
    for (const [key, child] of Object.entries(node)) {
      stack.push({ value: child, path: `${path}.${key}` });
    }
  }
  return found;
}

const text = JSON.stringify(RENDER_SCREEN_SCHEMA);

describe("the schema a model is held to", () => {
  it("closes every object, so a model cannot invent a property", () => {
    // Structured outputs require `additionalProperties: false` on every object.
    // One open object anywhere makes the whole schema unusable in strict mode —
    // and the reason the catalog carries none of the constraints below.
    for (const { path, node } of objectNodes(RENDER_SCREEN_SCHEMA)) {
      expect(node["additionalProperties"], `open object at ${path}`).toBe(false);
    }
  });

  it("uses none of the constraint keywords structured outputs reject", () => {
    // The catalog carries no length or range constraints precisely so this
    // holds — one definition serving both the satellite path and this one.
    for (const keyword of [
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "pattern",
      "format",
      "minItems",
      "maxItems",
      "uniqueItems",
    ]) {
      expect(text, `schema contains ${keyword}`).not.toContain(`"${keyword}"`);
    }
  });

  it("inlines everything rather than referencing it", () => {
    // Our own choice, not a known API limit: a `$ref` is one more thing that
    // has to resolve, and at this size there is nothing to save by sharing.
    for (const keyword of ["$ref", "$defs", "definitions", "$schema"]) {
      expect(text, `schema contains ${keyword}`).not.toContain(`"${keyword}"`);
    }
  });

  it("uses exactly one union construct, at the top level", () => {
    // Which JSON Schema combinators strict tool schemas accept is not something
    // this package can verify without calling the API — that happens when the
    // loop lands. Until then the schema stays as plain as a 34-way discriminated
    // union can be: one `oneOf`, and no `anyOf`, `allOf` or `not` anywhere.
    expect(text.split('"oneOf"')).toHaveLength(2);
    for (const keyword of ["anyOf", "allOf", "not"]) {
      expect(text, `schema contains ${keyword}`).not.toContain(`"${keyword}"`);
    }
  });

  it("covers every component in the catalog", () => {
    // A component the schema omits is one the agent can never compose, and
    // nothing about the omission would look like an error.
    for (const name of COMPONENT_NAMES) {
      expect(text, `no variant for ${name}`).toContain(`"${name}"`);
    }
  });

  it("stays small enough to send on every request", () => {
    // PLAN.md expected this to be large enough to need load-testing before
    // committing to it. It is not: the catalog's ban on length and range
    // keywords is most of the reason, and measuring beats assuming.
    expect(text.length).toBeLessThan(60_000);
  });
});

describe("what the model may not author", () => {
  it("omits the properties that carry facts rather than layout", () => {
    // The grounding rule made structural. A model cannot fabricate table rows
    // if the schema gives it nowhere to write them; the hub fills them from the
    // tool call the node cites.
    expect(AUTHORED_BY_TOOLS).toEqual({
      Table: ["rows"],
      Chart: ["data"],
    });
  });

  it("really does drop them from the emitted schema", () => {
    const table = componentSchema("Table");
    expect(Object.keys(table["properties"] as object)).not.toContain("rows");
    expect(Object.keys(table["properties"] as object)).toContain("columns");

    const chart = componentSchema("Chart");
    expect(Object.keys(chart["properties"] as object)).not.toContain("data");
    expect(Object.keys(chart["properties"] as object)).toContain("series");
  });

  it("omits opaque action payloads, which have no strict shape", () => {
    // An arbitrary payload cannot be described to a model that must not invent
    // properties. A governed write goes through a tool call, where the gateway
    // checks the arguments against a schema it published — not through a
    // payload the model hand-assembled into a button.
    const button = componentSchema("Button");
    const action = (button["properties"] as Record<string, Record<string, unknown>>)["action"];
    expect(Object.keys(action?.["properties"] as object)).toEqual(["actionId"]);
  });

  it("gives the model no way to say when a field is shown", () => {
    // Conditional visibility is a satellite authoring a form it owns; the agent
    // composes a view over tool results and collects no input. It is also the
    // one prop whose shape would cost this schema its two loudest guarantees —
    // `equals` needs a union and `oneOf` a non-empty array, and structured
    // outputs reject both.
    const textField = componentSchema("TextField");
    expect(Object.keys(textField["properties"] as object)).not.toContain("visibleWhen");
    expect(Object.keys(textField["properties"] as object)).toContain("name");
  });
});

describe("string maps, which JSON Schema can close and a record cannot", () => {
  it("projects Link params as a list of pairs", () => {
    // `Record<string, string>` is an open object by definition. The same
    // information as `[{key, value}]` is closed, and lowers back losslessly —
    // see `lower.ts`. Without this an agent could not link to a detail screen,
    // which is most of what cross-satellite composition is for.
    const link = componentSchema("Link");
    const params = (link["properties"] as Record<string, Record<string, unknown>>)["params"];
    expect(params?.["type"]).toBe("array");
    const item = params?.["items"] as Record<string, unknown>;
    expect(Object.keys(item["properties"] as object).sort()).toEqual(["key", "value"]);
    expect(item["additionalProperties"]).toBe(false);
  });

  it("projects a table's dataSource params the same way", () => {
    const table = componentSchema("Table");
    const source = (table["properties"] as Record<string, Record<string, unknown>>)["dataSource"];
    const params = (source?.["properties"] as Record<string, Record<string, unknown>>)["params"];
    expect(params?.["type"]).toBe("array");
  });
});

describe("the spec shape", () => {
  it("is the flat list, because a keyed map cannot be closed", () => {
    const schema = RENDER_SCREEN_SCHEMA as Record<string, Record<string, unknown>>;
    expect(Object.keys(schema["properties"] as object).sort()).toEqual(["elements", "root"]);
    expect((schema["properties"] as Record<string, Record<string, unknown>>)["elements"]?.["type"]).toBe(
      "array",
    );
  });

  it("requires a source on the nodes that carry facts", () => {
    // The other half of grounding: a StatTile may say any number it likes, so
    // it must say where the number came from.
    for (const name of ["StatTile", "Table", "Chart"]) {
      const required = componentSchema(name)["required"] as string[];
      expect(required, `${name} does not require a source`).toContain("source");
    }
  });

  it("does not require a source on a node that carries no fact", () => {
    expect(componentSchema("Heading")["required"] as string[]).not.toContain("source");
  });

  it("is regenerated rather than frozen, so a catalog addition cannot be forgotten", () => {
    // `renderScreenSchema()` reads the catalog at call time. If this ever
    // diverges from the exported constant, the constant was hand-edited.
    expect(renderScreenSchema()).toEqual(RENDER_SCREEN_SCHEMA);
  });
});

function componentSchema(name: string): Record<string, unknown> {
  const elements = (
    (RENDER_SCREEN_SCHEMA as Record<string, Record<string, Record<string, unknown>>>)[
      "properties"
    ] as Record<string, Record<string, unknown>>
  )["elements"] as Record<string, unknown>;
  const variants = (elements["items"] as Record<string, unknown>)["oneOf"] as Record<
    string,
    unknown
  >[];
  const match = variants.find((variant) => {
    const type = (variant["properties"] as Record<string, Record<string, unknown>>)["type"];
    return (type?.["enum"] as string[])?.[0] === name;
  });
  if (match === undefined) throw new Error(`no variant for ${name}`);
  return (match["properties"] as Record<string, Record<string, unknown>>)["props"] as Record<
    string,
    unknown
  >;
}
