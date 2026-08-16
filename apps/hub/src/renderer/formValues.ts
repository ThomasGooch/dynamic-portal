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

export function collectFormValues(form: HTMLFormElement): Record<string, unknown> {
  // Null-prototype: the result is serialised and posted, so a borrowed
  // prototype is one more way a field name can mean something it should not.
  const values = Object.create(null) as Record<string, unknown>;

  // A radio group is several elements and one value. Collected separately so an
  // unanswered group still reports itself, rather than vanishing the way the
  // browser would drop it.
  const radios = new Map<string, string | null>();

  for (const element of Array.from(form.elements)) {
    if (!isValueControl(element)) continue;
    if (element.name === "" || element.disabled) continue;

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
