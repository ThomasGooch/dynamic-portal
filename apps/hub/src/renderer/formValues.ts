/**
 * Reading a rendered form back out of the DOM as an action payload.
 *
 * The browser's own `FormData` is deliberately not used. It flattens everything
 * to strings and omits unchecked boxes entirely, so a satellite receiving it
 * cannot tell `false` from "the field was not on the form", and has to re-parse
 * every number it declared as a number. Both are the kind of difference that
 * shows up as a wrong branch taken silently, months later.
 *
 * What a satellite gets instead is shaped like what it declared: a
 * `NumberField` arrives as a number, a `Checkbox` as a boolean in both states,
 * a `MultiSelect` as an array even when empty, and a `DateRange` as
 * `{from, to}` — the same shape as the component's own props.
 */

import type { UiNode } from "@portal/protocol";

/** Names that would let a satellite's field write through the prototype chain. */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Controls that carry no value, or none this protocol can carry. */
const IGNORED_INPUT_TYPES: ReadonlySet<string> = new Set([
  "submit",
  "button",
  "reset",
  "image",
  // A file has no representation in a JSON action envelope. Sending the
  // filename alone would look like an upload that worked. See `FileUpload`.
  "file",
]);

export interface CollectOptions {
  /**
   * Whether a disabled control still reports its value.
   *
   * Off for a submission, because the browser would not send it either. On for
   * the visibility snapshot: a `visibleWhen` naming a disabled field is asking
   * what the user can *see*, and a disabled control is still on the screen with
   * a value in it. Without this, disabling a driver would silently hide every
   * field that depends on it.
   */
  readonly includeDisabled?: boolean;
}

export function collectFormValues(
  form: HTMLFormElement,
  options: CollectOptions = {},
): Record<string, unknown> {
  // Null-prototype: the result is serialised and posted, so a borrowed
  // prototype is one more way a field name can mean something it should not.
  const values = Object.create(null) as Record<string, unknown>;

  // A radio group is several elements and one value. Collected separately so an
  // unanswered group still reports itself, rather than vanishing the way the
  // browser would drop it.
  const radios = new Map<string, string | null>();

  for (const element of Array.from(form.elements)) {
    if (!isValueControl(element)) continue;
    if (element.name === "") continue;
    if (element.disabled && options.includeDisabled !== true) continue;

    if (element instanceof HTMLSelectElement) {
      const selected = Array.from(element.selectedOptions, (option) => option.value);
      setPath(values, element.name, element.multiple ? selected : (selected[0] ?? ""));
      continue;
    }

    if (element instanceof HTMLTextAreaElement) {
      setPath(values, element.name, element.value);
      continue;
    }

    const type = element.type.toLowerCase();
    if (IGNORED_INPUT_TYPES.has(type)) continue;

    if (type === "radio") {
      const current = radios.get(element.name) ?? null;
      radios.set(element.name, element.checked ? element.value : current);
      continue;
    }

    if (type === "checkbox") {
      setPath(values, element.name, element.checked);
      continue;
    }

    if (type === "number" || type === "range") {
      setPath(values, element.name, toNumber(element.value));
      continue;
    }

    setPath(values, element.name, element.value);
  }

  for (const [name, value] of radios) setPath(values, name, value);

  return values;
}

function isValueControl(
  element: Element,
): element is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  );
}

/** `null`, not `NaN` or `""` — an empty number field is an absent reading. */
function toNumber(raw: string): number | null {
  if (raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Writes `a.b.c` as nested objects, or drops the field entirely.
 *
 * Dropping rather than sanitising is deliberate: a field whose name reaches for
 * the prototype chain is not a typo to be repaired into something plausible.
 */
function setPath(root: Record<string, unknown>, name: string, value: unknown): void {
  const parts = name.split(".");
  if (parts.some((part) => part === "" || FORBIDDEN_SEGMENTS.has(part))) return;

  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part];
    if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
      cursor = existing as Record<string, unknown>;
    } else {
      const created = Object.create(null) as Record<string, unknown>;
      cursor[part] = created;
      cursor = created;
    }
  }

  cursor[parts[parts.length - 1] as string] = value;
}

/**
 * The same reading, taken from the satellite's tree instead of the DOM.
 *
 * Two things need it. A `visibleWhen` has to be answerable on the *first*
 * render — the hub server-renders the screen, and a form whose conditional
 * fields appear and then vanish on hydration is a flash of content that was
 * never true. And the renderer has to be able to tell "this rule names a field
 * this form does not have" from "it names one that is currently hidden": the
 * keys here are every field the form declared, hidden or not.
 *
 * It answers what `collectFormValues` would answer before anything is touched,
 * which is why it lives beside it — the two shapes have to agree, and a case
 * added to one is a case missing from the other.
 */
export function initialFormValues(form: UiNode): Record<string, unknown> {
  const values = Object.create(null) as Record<string, unknown>;
  walk(form.children ?? [], values);
  return values;
}

function walk(nodes: readonly UiNode[], values: Record<string, unknown>): void {
  for (const node of nodes) {
    // A nested form submits on its own, so its fields are not this one's.
    if (node.type === "Form") continue;

    const props = (node.props ?? {}) as Record<string, unknown>;
    const name = props["name"];
    // `name` belongs to inputs and to nothing else in the catalog, which is
    // what makes this a test for "is this a field" rather than a list of types
    // that would go stale the next time the catalog grows one.
    if (typeof name === "string" && name !== "") declared(values, node.type, name, props);

    walk(node.children ?? [], values);
  }
}

function declared(
  values: Record<string, unknown>,
  type: string,
  name: string,
  props: Record<string, unknown>,
): void {
  const value = props["value"];

  switch (type) {
    case "Checkbox":
    case "Switch":
      setPath(values, name, props["checked"] === true);
      return;

    case "NumberField":
      setPath(values, name, typeof value === "number" ? value : null);
      return;

    case "MultiSelect": {
      const options = optionValues(props);
      setPath(values, name, Array.isArray(value) ? value.filter((entry) => options.has(entry)) : []);
      return;
    }

    // A `value` naming no option is not a selection — the renderer falls back to
    // the placeholder, and this has to fall back with it or the two disagree
    // about what is currently chosen.
    case "Select":
      setPath(values, name, typeof value === "string" && optionValues(props).has(value) ? value : "");
      return;

    case "RadioGroup":
      setPath(
        values,
        name,
        typeof value === "string" && optionValues(props).has(value) ? value : null,
      );
      return;

    case "DateRange":
      setPath(values, `${name}.from`, typeof props["from"] === "string" ? props["from"] : "");
      setPath(values, `${name}.to`, typeof props["to"] === "string" ? props["to"] : "");
      return;

    // Chosen files are never collected, so a `FileUpload` reports nothing here
    // either — and a rule naming one is a rule about a field with no value.
    case "FileUpload":
      return;

    default:
      setPath(values, name, typeof value === "string" ? value : "");
  }
}

function optionValues(props: Record<string, unknown>): ReadonlySet<unknown> {
  const options = props["options"];
  if (!Array.isArray(options)) return new Set();
  return new Set(
    options.map((option) =>
      typeof option === "object" && option !== null
        ? (option as Record<string, unknown>)["value"]
        : undefined,
    ),

/**
 * The files a form is carrying, as `[name, File]` pairs.
 *
 * Separate from `collectFormValues`, which deliberately skips file inputs: a
 * `File` cannot go in a JSON envelope, and putting the *filename* there would
 * look like an upload that worked. This is the other half — the bytes, for the
 * multipart path — and keeping them apart is what lets the values map stay
 * serialisable.
 *
 * A `multiple` input contributes several pairs under one name, which is how
 * multipart carries a list.
 */
export function collectFormFiles(form: HTMLFormElement): [string, File][] {
  const files: [string, File][] = [];

  for (const element of Array.from(form.elements)) {
    if (!(element instanceof HTMLInputElement)) continue;
    if (element.type.toLowerCase() !== "file") continue;
    if (element.name === "" || element.disabled) continue;

    // An input the user never touched has an empty list, so an untouched
    // optional upload contributes nothing rather than an empty file.
    for (const file of Array.from(element.files ?? [])) files.push([element.name, file]);
  }

  return files;
}


/**
 * Whether this form can carry a file at all.
 *
 * The encoding follows the form's *shape*, not what the user picked. Deciding
 * it from the files actually chosen meant an untouched upload submitted as
 * JSON, and a satellite reading JSON on an action that expects multipart
 * cannot tell "no document" from "wrong content type" — so it answers with a
 * general failure where it means to point at the field.
 */
export function hasFileInput(form: HTMLFormElement): boolean {
  return Array.from(form.elements).some(
    (element) =>
      element instanceof HTMLInputElement &&
      element.type.toLowerCase() === "file" &&
      element.name !== "" &&
      !element.disabled,
  );
}
