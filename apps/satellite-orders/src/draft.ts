import type { OrderDraft, Priority } from "./repository";

/**
 * Reading a form submission, and saying precisely what is wrong with it.
 *
 * The satellite owns this, not the hub and not the catalog. A `NumberField`
 * carries `min`/`max` so the hub can render sensible input bounds, but those
 * are a rendering hint — the browser is not a trust boundary, and an action
 * can be posted directly. Every rule that matters is enforced here.
 *
 * Field errors are keyed by the `name` of the input that caused them, because
 * that is what the hub matches on when it renders the message against the
 * field rather than as a banner. An error keyed to a name no field carries is
 * an error nobody can act on.
 */

export const CURRENCIES = ["USD", "EUR", "GBP"] as const;
// `as const` rather than `readonly Priority[]`: the protocol's action param
// `enum` is `.nonempty()`, which surfaces in TypeScript as a non-empty tuple —
// a plain array cannot satisfy it, and that is the schema doing its job.
export const PRIORITIES = ["standard", "express", "critical"] as const satisfies readonly Priority[];
export const TAGS = ["retail", "wholesale", "priority", "fragile", "hazmat"] as const;

/** The largest order this satellite will take without a human deciding. */
const MAX_TOTAL = 100_000;

export type DraftResult =
  | { ok: true; draft: OrderDraft }
  | { ok: false; fieldErrors: Record<string, string> };

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** A shape check, deliberately not a deliverability one. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `YYYY-MM-DD`, which is what a `DateField` submits. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function asList(value: unknown): string[] {
  // A MultiSelect posts an array; a form-encoded body may collapse a single
  // selection to a scalar, and dropping it would silently lose the user's
  // choice rather than reject it.
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return typeof value === "string" && value !== "" ? [value] : [];
}

function asBoolean(value: unknown): boolean {
  // Checkboxes arrive as `true`, `"true"`, or `"on"` depending on how the body
  // was encoded. Anything else is unchecked.
  return value === true || value === "true" || value === "on";
}

export function readDraft(body: unknown, today: string): DraftResult {
  const input = (body ?? {}) as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};

  const customer = text(input["customer"]);
  if (customer === "") fieldErrors["customer"] = "Who is this order for?";
  else if (customer.length > 120) fieldErrors["customer"] = "Keep this under 120 characters.";

  const contactEmail = text(input["contactEmail"]);
  if (contactEmail === "") fieldErrors["contactEmail"] = "A contact address is required.";
  else if (!EMAIL.test(contactEmail)) fieldErrors["contactEmail"] = "That does not look like an email address.";

  const rawTotal = input["total"];
  const total = typeof rawTotal === "number" ? rawTotal : Number.parseFloat(text(rawTotal));
  if (!Number.isFinite(total)) fieldErrors["total"] = "A total is required.";
  else if (total <= 0) fieldErrors["total"] = "A total must be more than zero.";
  else if (total > MAX_TOTAL) {
    fieldErrors["total"] = `Orders above ${MAX_TOTAL.toLocaleString("en-US")} are placed by the desk, not here.`;
  }

  const currency = text(input["currency"]);
  if (!CURRENCIES.includes(currency as (typeof CURRENCIES)[number])) {
    fieldErrors["currency"] = "Choose a currency.";
  }

  const dueBy = text(input["dueBy"]);
  if (dueBy === "") fieldErrors["dueBy"] = "When is this due?";
  else if (!ISO_DATE.test(dueBy)) fieldErrors["dueBy"] = "Use a calendar date.";
  else if (dueBy < today) fieldErrors["dueBy"] = "That date has already passed.";

  const priority = text(input["priority"]) as Priority;
  if (!PRIORITIES.includes(priority)) fieldErrors["priority"] = "Choose a priority.";

  const tags = asList(input["tags"]);
  const unknownTag = tags.find((tag) => !TAGS.includes(tag as (typeof TAGS)[number]));
  if (unknownTag !== undefined) fieldErrors["tags"] = `${unknownTag} is not a label we use.`;

  const expedited = asBoolean(input["expedited"]);
  const notes = text(input["notes"]);
  if (notes.length > 500) fieldErrors["notes"] = "Keep notes under 500 characters.";

  /**
   * The cross-field rules, which are the reason this file exists.
   *
   * Neither is expressible as a per-input constraint, and both are the kind of
   * rule every real form has. If a fixed component vocabulary could not carry
   * them, that would be the ceiling this architecture is bet against.
   */
  if (expedited && priority === "standard") {
    fieldErrors["priority"] = "An expedited order cannot be standard priority.";
  }
  if (tags.includes("hazmat") && notes === "") {
    fieldErrors["notes"] = "Hazmat orders need handling notes.";
  }
  if (priority === "critical" && !expedited) {
    fieldErrors["expedited"] = "Critical orders are expedited.";
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  return {
    ok: true,
    draft: {
      customer,
      contactEmail,
      total,
      currency,
      dueBy,
      priority,
      tags,
      expedited,
      ...(notes === "" ? {} : { notes }),
    },
  };
}
