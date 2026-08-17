import { FlatSpecSchema, type FlatSpec } from "@portal/catalog";

/**
 * Turning what a model may emit into what the catalog accepts.
 *
 * The only difference between the two is the string maps. `Record<string,
 * string>` is an open object, so `schema.ts` projects `params` as a closed list
 * of `{key, value}` pairs; this converts it back. Everything else is already
 * the catalog's own shape — there is no second vocabulary here, only one
 * property whose JSON Schema representation could not be closed.
 *
 * Lowering is not the last word. The flat schema still validates the result,
 * because the strict schema constrains what the model *may say* and the catalog
 * decides what the hub will *render*, and those are different jobs.
 */

/** Mirrors `STRING_MAP_PROPERTIES` in `schema.ts`. */
const PAIR_LIST_PROPERTIES = new Set(["params"]);

/** Keys that would let a model's parameter name write through the prototype. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface LoweringIssue {
  readonly elementId: string;
  readonly message: string;
}

export type LoweringResult =
  | { readonly ok: true; readonly spec: FlatSpec }
  | { readonly ok: false; readonly issues: readonly LoweringIssue[] };

export function lowerSpec(raw: unknown): LoweringResult {
  const issues: LoweringIssue[] = [];

  const source = raw as { root?: unknown; elements?: unknown };
  const elements = Array.isArray(source.elements) ? source.elements : [];

  const lowered = elements.map((element, index) => {
    const record = asRecord(element) ?? {};
    const id = typeof record["id"] === "string" ? record["id"] : `element ${index}`;
    const props = asRecord(record["props"]);
    return {
      ...record,
      ...(props === undefined ? {} : { props: lowerValue(props, id, issues) }),
    };
  });

  if (issues.length > 0) return { ok: false, issues };

  const parsed = FlatSpecSchema.safeParse({ ...source, elements: lowered });
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        // The path starts `elements.<index>`, so the element's own id is more
        // use to whoever reads this than a position in an array they cannot see.
        elementId: idAt(lowered, issue.path),
        message: issue.message,
      })),
    };
  }

  return { ok: true, spec: parsed.data };
}

function lowerValue(value: unknown, elementId: string, issues: LoweringIssue[]): unknown {
  if (Array.isArray(value)) return value.map((item) => lowerValue(item, elementId, issues));

  const record = asRecord(value);
  if (record === undefined) return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (FORBIDDEN_KEYS.has(key)) {
      // `out["__proto__"] = child` runs the accessor rather than writing a
      // property: the key vanishes and `child`'s own keys become inherited
      // enumerables that Zod's record parse then hoists into props. That is a
      // route to the properties `schema.ts` deliberately deleted — `Table.rows`,
      // `Chart.data`, an action `payload` — so it is refused, not repaired.
      issues.push({ elementId, message: `property "${key}" is not permitted` });
      continue;
    }
    out[key] = PAIR_LIST_PROPERTIES.has(key)
      ? toRecord(child, elementId, key, issues)
      : lowerValue(child, elementId, issues);
  }
  return out;
}

function toRecord(
  value: unknown,
  elementId: string,
  property: string,
  issues: LoweringIssue[],
): unknown {
  if (!Array.isArray(value)) return value;

  // Null-prototype: the keys came from a model, and the result is spread into
  // props that reach a URL builder.
  const out = Object.create(null) as Record<string, string>;

  for (const entry of value) {
    const pair = asRecord(entry);
    const key = pair?.["key"];
    const item = pair?.["value"];
    if (typeof key !== "string" || typeof item !== "string") {
      issues.push({ elementId, message: `${property} contains something that is not a key/value pair` });
      continue;
    }
    if (FORBIDDEN_KEYS.has(key)) {
      // Dropped, not sanitised: a key reaching for the prototype chain is not a
      // typo to be repaired into something plausible.
      issues.push({ elementId, message: `${property} key "${key}" is not permitted` });
      continue;
    }
    if (Object.hasOwn(out, key)) {
      // Two declarations of one param, and no way to tell which was meant.
      // Keeping either produces a link to a record nobody asked for.
      issues.push({ elementId, message: `${property} declares "${key}" twice` });
      continue;
    }
    out[key] = item;
  }

  return out;
}

/**
 * The element id behind a Zod issue path, for both this file and `grounding.ts`
 * — a position in an array the reader cannot see names nothing.
 */
export function idAt(elements: readonly unknown[], path: readonly (string | number)[]): string {
  if (path[0] !== "elements" || typeof path[1] !== "number") return "(spec)";
  const element = asRecord(elements[path[1]]);
  const id = element?.["id"];
  return typeof id === "string" ? id : `element ${path[1]}`;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
