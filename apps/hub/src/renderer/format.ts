/**
 * Turning satellite *data* into a string the hub is willing to display.
 *
 * Table rows and key-value items carry `unknown` on purpose — they are the
 * satellite's records, not the catalog's vocabulary. That makes this the one
 * place in the renderer that meets values no schema described, so it has to
 * have an answer for every JavaScript value rather than the three it expects.
 *
 * **Everything here is locale- and timezone-independent, deliberately.** The
 * same tree renders once on the server and again in the browser. A value
 * formatted with the ambient locale or zone produces two different strings and
 * React reports a hydration mismatch — which, on a developer's machine running
 * in UTC, never happens. Presenting dates in the viewer's own zone is a real
 * feature and a later one; it needs the zone to travel with the render, not to
 * be read independently at each end.
 */

/** Mirrors the catalog's `ValueFormat`. */
export type ValueFormat = "text" | "badge" | "date" | "datetime" | "money" | "code";

/** Shown where a value is absent or unrenderable, so a cell is never blank. */
const BLANK = "—";

const decimal = new Intl.NumberFormat("en-US");
const money = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatValue(value: unknown, as: ValueFormat | undefined): string {
  if (value === null || value === undefined || value === "") return BLANK;

  switch (as) {
    case "money":
      // A satellite that sends "1.2.3" gets its own string back. Coercing would
      // turn a data bug into `NaN`, which reads as a hub bug.
      return typeof value === "number" && Number.isFinite(value)
        ? money.format(value)
        : formatValue(value, undefined);

    case "date":
    case "datetime": {
      const instant = toInstant(value);
      if (instant === undefined) return formatValue(value, undefined);
      const iso = instant.toISOString();
      return as === "date" ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
    }

    case "code":
      // Untouched: leading and trailing whitespace is often the point.
      return typeof value === "string" ? value : formatValue(value, undefined);

    default:
      return plain(value);
  }
}

function plain(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? decimal.format(value) : BLANK;
  if (typeof value === "bigint") return value.toString();
  // `String(false)` inside JSX renders an empty cell, which reads as missing
  // data rather than as a false value.
  if (typeof value === "boolean") return value ? "Yes" : "No";

  try {
    const json = JSON.stringify(value);
    return json ?? BLANK;
  } catch {
    // Cyclic, or a BigInt nested inside. A dash beats a thrown render.
    return BLANK;
  }
}

function toInstant(value: unknown): Date | undefined {
  if (typeof value === "number") {
    const fromEpoch = new Date(value);
    return Number.isNaN(fromEpoch.getTime()) ? undefined : fromEpoch;
  }
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
