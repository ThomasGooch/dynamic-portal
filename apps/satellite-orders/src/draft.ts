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

/**
 * A MultiSelect posts an array; a form-encoded body may collapse a single
 * selection to a scalar, and dropping that would silently lose the user's
 * choice rather than reject it.
 *
 * `null` means "not a list of labels at all". Filtering the non-strings out
 * instead would read `["retail", 7]` as `["retail"]` — a submission silently
 * altered rather than refused, which is the failure this whole file exists to
 * avoid. Duplicates collapse: the widget cannot produce them, a direct post
 * can, and `["hazmat", "hazmat"]` is one label however it was written.
 */
function asList(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    if (!value.every((v): v is string => typeof v === "string")) return null;
    return [...new Set(value.map((v) => v.trim()).filter((v) => v !== ""))];
  }
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value.trim() === "" ? [] : [value.trim()];
  return null;
}

/**
 * Checkboxes arrive as `true`, `"true"`, or `"on"` depending on how the body
 * was encoded, and as `false`/`"false"`/`""`/absent when unticked.
 *
 * `null` for anything else, rather than the obvious `false`. Reading `1` or
 * `"yes"` as unticked is a submission that means one thing and is stored as
 * another — and because `expedited` carries a cross-field rule, the user is
 * then told their *priority* is wrong about a box they believe they ticked.
 */
function asBoolean(value: unknown): boolean | null {
  if (value === true || value === "true" || value === "on") return true;
  if (value === false || value === "false" || value === "" || value === undefined || value === null) {
    return false;
  }
  return null;
}

/**
 * A total, or `null`.
 *
 * `Number.parseFloat` is deliberately not used: it reads a prefix, so `"12abc"`
 * becomes `12` and a submission nobody typed gets stored as if they had. The
 * pattern is what a `NumberField` with `step: 0.01` can actually produce, and
 * two decimals is the money rule the field's step already implies — a total of
 * `1.005` is a rounding argument waiting to happen at the first invoice.
 */
const MONEY = /^-?\d+(\.\d{1,2})?$/;

const isMoney = (value: number): boolean =>
  Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;

function asTotal(value: unknown): number | null {
  if (typeof value === "number") return isMoney(value) ? value : null;
  const raw = text(value);
  if (!MONEY.test(raw)) return null;
  const parsed = Number(raw);
  return isMoney(parsed) ? parsed : null;
}

export function readDraft(body: unknown, today: string): DraftResult {
  const input = (body ?? {}) as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};

  const customer = text(input["customer"]);
  if (customer === "") fieldErrors["customer"] = "Who is this order for?";
  else if (customer.length > 120) fieldErrors["customer"] = "Keep this under 120 characters.";

  const contactEmail = text(input["contactEmail"]);
  if (contactEmail === "") fieldErrors["contactEmail"] = "A contact address is required.";
  // Bounded like every other free-text field. `EMAIL` constrains the shape and
  // not the size, so without this an address of any length at all is stored —
  // the one string on this form a direct poster could make arbitrarily large.
  else if (contactEmail.length > 254) fieldErrors["contactEmail"] = "That address is too long.";
  else if (!EMAIL.test(contactEmail)) fieldErrors["contactEmail"] = "That does not look like an email address.";

  // An empty `NumberField` posts `null`, so "absent" and "unreadable" are the
  // same answer to the user: there is no total here yet.
  const total = asTotal(input["total"]);
  if (total === null) fieldErrors["total"] = "A total is required, to the penny.";
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

  // Absent is not the same answer as empty. An empty `MultiSelect` posts `[]`,
  // so a user clearing every label sends one; a caller that simply did not
  // mention labels sends nothing, which `tags` being optional keeps possible
  // for agents too. Passing the difference through to the draft is what stops
  // an update erasing labels it never named — see `OrderDraft.tags`.
  const tagsGiven = input["tags"] !== undefined;
  const parsedTags = asList(input["tags"]);
  const tags = parsedTags ?? [];
  if (parsedTags === null) fieldErrors["tags"] = "Choose labels from the list.";
  else {
    const unknownTag = tags.find((tag) => !TAGS.includes(tag as (typeof TAGS)[number]));
    if (unknownTag !== undefined) fieldErrors["tags"] = `${unknownTag} is not a label we use.`;
  }

  const expediteReason = text(input["expediteReason"]);
  // Typed like `notes`, and for the same reason: `text` answers `""` for a
  // number, so `expediteReason: 42` would be stored as no reason at all and
  // nobody told — the silent alteration this file exists to refuse.
  if (
    input["expediteReason"] !== undefined &&
    input["expediteReason"] !== null &&
    typeof input["expediteReason"] !== "string"
  ) {
    fieldErrors["expediteReason"] = "A reason is text.";
  } else if (expediteReason.length > 200) {
    fieldErrors["expediteReason"] = "Keep this under 200 characters.";
  }

  const parsedExpedited = asBoolean(input["expedited"]);
  const expedited = parsedExpedited ?? false;
  if (parsedExpedited === null) fieldErrors["expedited"] = "Tick this box or leave it clear.";

  const notes = text(input["notes"]);
  // Anything present and not a string, not just an object: `text` answers `""`
  // for a number too, so `notes: 42` would otherwise be stored as no note at
  // all and nobody told — the same silent alteration `tags` and `total` refuse.
  if (input["notes"] !== undefined && input["notes"] !== null && typeof input["notes"] !== "string") {
    fieldErrors["notes"] = "Notes are text.";
  } else if (notes.length > 500) fieldErrors["notes"] = "Keep notes under 500 characters.";

  /**
   * The cross-field rules, which are the reason this file exists.
   *
   * None is expressible as a per-input constraint, and every real form has
   * them. If a fixed component vocabulary could not carry them, that would be
   * the ceiling this architecture is bet against.
   *
   * Each one refuses to overwrite a message already on its field. A cross-field
   * rule reads values the per-field rules may have just rejected, so without the
   * guard the second message replaces the first and the user is told the
   * consequence of a mistake instead of the mistake — "critical orders are
   * expedited" on a box whose real problem is that its value was not a boolean.
   * They are also skipped where the value they read is untrustworthy.
   */
  const keep = (name: string, message: string): void => {
    if (fieldErrors[name] === undefined) fieldErrors[name] = message;
  };

  if (parsedExpedited !== null && expedited && priority === "standard") {
    keep("priority", "An expedited order cannot be standard priority.");
  }
  if (parsedTags !== null && tags.includes("hazmat") && notes === "") {
    keep("notes", "Hazmat orders need handling notes.");
  }
  if (parsedExpedited !== null && priority === "critical" && !expedited) {
    keep("expedited", "Critical orders are expedited.");
  }

  // `total === null` is redundant with the error map above and is here for the
  // compiler: it is what narrows `total` to a number for the draft below,
  // rather than an assertion that would still stand if the rule were deleted.
  if (total === null || Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  return {
    ok: true,
    draft: {
      customer,
      contactEmail,
      total,
      currency,
      dueBy,
      priority,
      ...(tagsGiven ? { tags } : {}),
      expedited,
      // Kept only when it applies. A reason typed before the box was cleared
      // would otherwise be stored against an order that is not expedited: the
      // field was hidden, and its value can still reach here, because the form
      // decides what is drawn and the satellite decides what is true.
      ...(expedited && expediteReason !== "" ? { expediteReason } : {}),
      ...(notes === "" ? {} : { notes }),
    },
  };
}
