import type { COMPONENTS } from "@portal/catalog";
import type { z } from "zod";

/**
 * Evaluating a `visibleWhen` against the form it is rendered in.
 *
 * Kept out of the components, and free of React, because the interesting cases
 * are not about drawing anything: a rule naming a field that is itself hidden,
 * a rule naming a field that does not exist, a rule reaching into one half of a
 * `DateRange`. Those are answerable in a unit test, and a browser is not.
 */

/** Derived from the catalog, so a change there is a compile error here. */
export type VisibleWhen = NonNullable<z.infer<(typeof COMPONENTS)["TextField"]>["visibleWhen"]>;

/** Nothing at this path — told apart from a field that is genuinely empty. */
const ABSENT = Symbol("absent");

/**
 * Whether a field is shown right now.
 *
 * Three answers, and the difference between the last two is the whole of it:
 *
 *  - the rule matches the current value — shown;
 *  - the field it names is on this form but not on the screen, because it is
 *    itself hidden or has not been drawn — **hidden**. Otherwise a chain
 *    ("reason" depends on "expedited", "approver" depends on "reason") would
 *    invert the moment its first link disappeared, and the field would be shown
 *    *and submitted* precisely when its condition cannot hold;
 *  - the field it names is not on this form at all — shown. That is a satellite
 *    bug, and the choice is between hiding a control, which reads as a missing
 *    feature, and showing one that should not be there. Showing it is
 *    recoverable, and the satellite still validates what it receives.
 *
 * Hiding therefore only ever propagates into more hiding, which is what keeps a
 * pair of fields naming each other from flickering: the answer settles.
 */
export function isVisible(
  rule: VisibleWhen | undefined,
  values: Record<string, unknown>,
  declared: ReadonlySet<string>,
): boolean {
  if (rule === undefined) return true;

  const value = read(values, rule.field);
  if (value === ABSENT) {
    // `window.from` is half of a `DateRange`; the form declared `window`.
    const root = rule.field.split(".")[0] ?? rule.field;
    return !declared.has(root);
  }

  if (rule.equals !== undefined) return value === rule.equals;
  // Neither test given. The catalog refuses it, so this is a rule that reached
  // the browser some other way — show the control rather than lose it.
  if (rule.oneOf === undefined) return true;

  // A multi-select holds several values at once, so membership means the
  // selection *includes* one of these rather than equals it.
  const oneOf = rule.oneOf;
  return Array.isArray(value) ? value.some((entry) => oneOf.includes(entry as string)) : oneOf.includes(value as string);
}

/** `a.b` as the collected values nest it, so half a `DateRange` is reachable. */
function read(values: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = values;
  for (const part of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null || !Object.hasOwn(cursor, part)) return ABSENT;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}
