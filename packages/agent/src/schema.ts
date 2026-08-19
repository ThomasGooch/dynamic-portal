import { COMPONENTS, COMPONENT_NAMES, type ComponentName } from "@portal/catalog";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * The schema a model is held to when it composes a screen.
 *
 * This is the catalog, projected. Not a second vocabulary — the same Zod
 * definitions the satellites are validated against, converted to JSON Schema so
 * the API can constrain generation before our own validator ever runs. Two
 * layers, neither of them a prompt.
 *
 * Three edits happen on the way, and each is the grounding rule made
 * structural rather than advisory.
 *
 * **Facts are removed.** `Table.rows` and `Chart.data` are `Record<string,
 * unknown>` — arbitrary satellite data, and an open object no strict schema can
 * close. They are also exactly what a model must not invent. Deleting them
 * solves both at once: the model composes the table, cites the tool call, and
 * the hub fills the rows in from that call's result. A fabricated row is not
 * rejected after the fact; there is nowhere to write one.
 *
 * **Opaque payloads are removed.** An action `payload` has no shape to describe
 * to a model that must not invent properties. A governed write goes through a
 * tool call, where the gateway checks arguments against a schema it published —
 * not through a payload hand-assembled into a button.
 *
 * **String maps become pairs.** `Record<string, string>` is an open object by
 * definition; `[{key, value}]` carries the same information and closes. Without
 * it an agent could not link to a detail screen, which is most of what
 * cross-satellite composition is for. `lower.ts` converts it back.
 */

/** Properties a model may not author, because they are facts rather than layout. */
export const AUTHORED_BY_TOOLS: Readonly<Partial<Record<ComponentName, readonly string[]>>> =
  Object.freeze({
    Table: Object.freeze(["rows"]),
    Chart: Object.freeze(["data"]),
  });

/** Nodes that display a fact, and must therefore say where it came from. */
export const MUST_CITE_A_SOURCE: readonly ComponentName[] = Object.freeze([
  "StatTile",
  // Label/value pairs are data by definition. Leaving this off meant a model
  // could state any figure in a key-value list and cite nothing, while the
  // tile beside it was held to a citation — the grounding rule with a hole in
  // it exactly where the prose said there was none.
  "KeyValueList",
  "Table",
  "Chart",
]);

/**
 * Properties the model never authors, dropped from its schema.
 *
 * `payload` is an opaque bag with no describable shape — left in, it would be
 * an open object in a schema whose whole claim is that it has none.
 *
 * `visibleWhen` is different: it has a perfectly good shape, and the model
 * still has no business writing it. Conditional visibility is a satellite
 * authoring a form it owns; the agent composes a view over tool results and
 * does not collect input. Leaving it in would also cost the strict schema its
 * two loudest guarantees — the rule needs a union for `equals` and a
 * non-empty array for `oneOf`, and structured outputs reject both. The schema
 * tests caught that the moment it was added, which is why they exist.
 */
const OPAQUE_PROPERTIES = new Set(["payload", "visibleWhen"]);

/** `Record<string, string>` properties, projected as closed key/value pairs. */
const STRING_MAP_PROPERTIES = new Set(["params"]);

type Json = Record<string, unknown>;

const PAIR_LIST: Json = {
  type: "array",
  items: {
    type: "object",
    properties: { key: { type: "string" }, value: { type: "string" } },
    required: ["key", "value"],
    additionalProperties: false,
  },
};

/**
 * Builds the schema from the catalog as it is right now.
 *
 * Regenerated rather than checked in: a component added to the catalog and
 * forgotten here would be one the agent could never compose, and nothing about
 * that omission would look like an error.
 */
export function renderScreenSchema(): Json {
  const variants = COMPONENT_NAMES.map((name) => ({
    type: "object",
    properties: {
      id: { type: "string" },
      // A single-member enum is what makes this a discriminated union: the
      // model picks a variant by naming the component, and every other property
      // in that variant is then fixed.
      type: { type: "string", enum: [name] },
      props: propsFor(name),
      children: { type: "array", items: { type: "string" } },
    },
    // `children` is never required: a leaf has none, and demanding an empty
    // array everywhere is noise the model must emit on every node.
    required: ["id", "type", "props"],
    additionalProperties: false,
  }));

  return {
    type: "object",
    properties: {
      root: { type: "string" },
      elements: { type: "array", items: { oneOf: variants } },
    },
    required: ["root", "elements"],
    additionalProperties: false,
  };
}

function propsFor(name: ComponentName): Json {
  const converted = zodToJsonSchema(COMPONENTS[name], {
    // Inlined rather than referenced: a `$ref` is one more thing to be sure the
    // API resolves, and at this size there is nothing to save.
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Json;

  const schema = rewrite(converted, name) as Json;

  if (MUST_CITE_A_SOURCE.includes(name)) {
    // Required, not optional. A `StatTile` may say any number it likes, so it
    // has to say where the number came from — and "forgot to cite" and
    // "declined to cite" are the same thing to a reader.
    schema["required"] = [...new Set([...asArray(schema["required"]), "source"])];
  }

  return schema;
}

/** One iterative pass: drop what cannot be closed, reshape what can. */
function rewrite(node: unknown, component: ComponentName): unknown {
  if (Array.isArray(node)) return node.map((item) => rewrite(item, component));
  if (typeof node !== "object" || node === null) return node;

  const source = node as Json;
  const out: Json = {};

  for (const [key, value] of Object.entries(source)) {
    if (key !== "properties") {
      // `$schema` is metadata the API has no use for and one more unknown
      // keyword to explain away.
      if (key !== "$schema") out[key] = rewrite(value, component);
      continue;
    }

    const properties: Json = {};
    for (const [name, definition] of Object.entries(value as Json)) {
      if ((AUTHORED_BY_TOOLS[component] ?? []).includes(name)) continue;
      if (OPAQUE_PROPERTIES.has(name)) continue;
      properties[name] = STRING_MAP_PROPERTIES.has(name)
        ? PAIR_LIST
        : rewrite(definition, component);
    }
    out[key] = properties;
  }

  // Dropping a property must drop it from `required` too, or the schema demands
  // something it does not describe.
  if (Array.isArray(out["required"]) && typeof out["properties"] === "object") {
    const present = new Set(Object.keys(out["properties"] as Json));
    out["required"] = (out["required"] as unknown[]).filter(
      (name) => typeof name === "string" && present.has(name),
    );
  }

  // Every object closes. This is the property the whole strict path rests on.
  if (out["type"] === "object" && out["additionalProperties"] !== false) {
    out["additionalProperties"] = false;
  }

  return out;
}

const asArray = (value: unknown): string[] =>
  Array.isArray(value) ? (value.filter((item) => typeof item === "string") as string[]) : [];

/** The catalog as the API will see it. */
export const RENDER_SCREEN_SCHEMA: Json = renderScreenSchema();
