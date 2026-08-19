import { z } from "zod";

/**
 * The component vocabulary.
 *
 * Two rules govern everything in this file.
 *
 * **Semantic props only.** A component says `tone: "danger"`, never
 * `color: "#c00"`. The hub owns presentation; a producer that could specify
 * pixels would defeat the reason this architecture exists. Every schema is
 * `.strict()`, so a style escape hatch is rejected rather than ignored.
 *
 * **No length or range constraints.** The agent emits screens through a tool
 * whose `input_schema` is this catalog with `strict: true`, and structured
 * outputs reject `minLength` / `maximum`-style keywords. Expressing
 * requiredness and enums but never size means one definition serves both the
 * satellite path and the agent path, instead of two that can drift.
 */

export const CATALOG_VERSION = "1.0";

// ---------------------------------------------------------------------------
// Shared vocabularies. Reused rather than re-spelled so "what tones exist" has
// exactly one answer.
// ---------------------------------------------------------------------------

const Tone = z.enum(["neutral", "muted", "info", "success", "warning", "danger"]);
const Size = z.enum(["sm", "md", "lg"]);
const Align = z.enum(["start", "center", "end"]);
const Gap = z.enum(["none", "xs", "sm", "md", "lg"]);

/** How a value should be presented, without saying how it should look. */
const ValueFormat = z.enum(["text", "badge", "date", "datetime", "money", "code"]);

/** Fires a satellite action. The payload is opaque to the hub. */
const ActionRef = z
  .object({
    actionId: z.string(),
    payload: z.record(z.unknown()).optional(),
  })
  .strict();

/** Navigates within the portal. Never a bare URL — see `Link`. */
const ScreenRef = z
  .object({
    screenId: z.string(),
    satelliteId: z.string().optional(),
    params: z.record(z.string()).optional(),
  })
  .strict();

const Confirm = z.object({ title: z.string(), body: z.string().optional() }).strict();

const Option = z
  .object({ value: z.string(), label: z.string(), disabled: z.boolean().optional() })
  .strict();

const Column = z
  .object({
    key: z.string(),
    label: z.string(),
    align: Align.optional(),
    as: ValueFormat.optional(),
    /** Names another column supplying this cell's tone, for badge rendering. */
    toneKey: z.string().optional(),
  })
  .strict();

/** Ties a rendered value back to the tool call that produced it. */
const Source = z.object({ toolCallId: z.string() }).strict();

/**
 * Absolute http(s) only.
 *
 * `z.string().url()` is `new URL()` under the hood, so it accepts
 * `javascript:` and `data:` — a satellite could hand the hub a `Link` that
 * executes script when clicked. Scheme is checked explicitly instead. Expressed
 * as a refinement rather than a string format so the emitted JSON schema stays
 * within what structured outputs accept.
 */
const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * When a field is shown, expressed as data rather than a condition.
 *
 * `{ field, equals }` and `{ field, oneOf }` are the whole language, and that
 * is the point. A satellite declaring "show the reason box once they tick
 * expedite" needs no code in the hub and no code of its own; anything richer —
 * an expression, a callback, a rule engine — would put satellite logic back in
 * the browser, which is the thing this architecture refuses.
 *
 * For a multi-select, `oneOf` means the selection *includes* one of these. For
 * everything else it is membership of the single current value.
 *
 * `field` names another field of the same form, by the `name` it was given —
 * or one half of a `DateRange`, as `window.from`, because that is how the two
 * controls of a range are collected. Both tests compare against the value the
 * field *collects*, which is why they are a string or a boolean and not a
 * number: a `NumberField` collects a number, and a condition on one would
 * silently never match. Drive a condition from a `Select`, a `RadioGroup`, a
 * `MultiSelect` or a `Checkbox`.
 *
 * A rule naming a field the form does not have leaves the control on the
 * screen rather than removing it — a typo should be a visible bug, not a
 * feature that quietly disappears. Naming a field that is *itself* hidden does
 * hide this one, so a chain of conditions collapses in the right direction.
 *
 * **Presentation only.** A hidden field is not rendered and therefore is not
 * submitted, but nothing stops a caller posting it directly — the action
 * endpoint is an HTTP endpoint. Every rule this mirrors must also exist in the
 * satellite's own validation, and `orders` has a test that posts a hidden
 * field's value to prove the server still refuses it.
 */
const VisibleWhen = z
  .object({
    field: z.string(),
    equals: z.union([z.string(), z.boolean()]).optional(),
    oneOf: z.array(z.string()).optional(),
  })
  .strict()
  // Refinements rather than `.min(1)` and `.nonempty()`: this catalog has to
  // stay expressible in structured outputs, which reject length and range
  // keywords, and its own test enforces that. A refinement checks the same
  // things without emitting one.
  .superRefine((rule, ctx) => {
    // Exactly one test. Both would need a rule about how they combine, and
    // neither describes anything at all.
    const given = [rule.equals !== undefined, rule.oneOf !== undefined].filter(Boolean).length;
    if (given !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "visibleWhen needs exactly one of `equals` or `oneOf`",
      });
    }
    if (rule.field.trim() === "") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["field"], message: "field is required" });
    }
    if (rule.oneOf !== undefined && rule.oneOf.length === 0) {
      // An empty list matches nothing, so the field is simply never shown —
      // which reads as a bug in the satellite rather than a choice.
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["oneOf"], message: "oneOf needs a value" });
    }
  });

const field = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object({
      name: z.string(),
      label: z.string(),
      required: z.boolean().optional(),
      help: z.string().optional(),
      disabled: z.boolean().optional(),
      visibleWhen: VisibleWhen.optional(),
      ...shape,
    })
    .strict();

// ---------------------------------------------------------------------------
// The catalog itself
// ---------------------------------------------------------------------------

export const COMPONENTS = {
  // -- Layout (8) ----------------------------------------------------------
  Page: z.object({ title: z.string().optional() }).strict(),
  Section: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      collapsible: z.boolean().optional(),
    })
    .strict(),
  Stack: z
    .object({
      direction: z.enum(["row", "column"]).optional(),
      gap: Gap.optional(),
      align: Align.optional(),
      wrap: z.boolean().optional(),
    })
    .strict(),
  Grid: z.object({ columns: z.number().int(), gap: Gap.optional() }).strict(),
  Card: z.object({ title: z.string().optional(), tone: Tone.optional() }).strict(),
  Tabs: z
    .object({
      tabs: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
      activeId: z.string().optional(),
    })
    .strict(),
  Divider: z.object({ spacing: Gap.optional() }).strict(),
  Modal: z
    .object({ title: z.string(), open: z.boolean().optional(), size: Size.optional() })
    .strict(),

  // -- Display (10) --------------------------------------------------------
  Heading: z
    .object({ text: z.string(), level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional() })
    .strict(),
  Text: z
    .object({ text: z.string(), tone: Tone.optional(), size: Size.optional(), emphasis: z.boolean().optional() })
    .strict(),
  Badge: z.object({ label: z.string(), tone: Tone.optional() }).strict(),
  StatTile: z
    .object({
      label: z.string(),
      value: z.string(),
      caption: z.string().optional(),
      tone: Tone.optional(),
      source: Source.optional(),
    })
    .strict(),
  KeyValueList: z
    .object({
      items: z.array(
        z
          .object({
            label: z.string(),
            value: z.string(),
            as: ValueFormat.optional(),
            tone: Tone.optional(),
          })
          .strict(),
      ),
      /**
       * A key-value list is label/value pairs, which is data by definition —
       * so it can say where the data came from, and on the agent path it must.
       * Without this a model could state any figure here and cite nothing,
       * while the tile beside it was held to a citation.
       */
      source: Source.optional(),
    })
    .strict(),
  Table: z
    .object({
      columns: z.array(Column),
      rows: z.array(z.record(z.unknown())).optional(),
      /** Server-side paging: the hub re-fetches this screen rather than the satellite paging itself. */
      dataSource: ScreenRef.optional(),
      rowAction: z.object({ screenId: z.string(), paramKey: z.string() }).strict().optional(),
      emptyMessage: z.string().optional(),
      page: z.number().int().optional(),
      pageSize: z.number().int().optional(),
      total: z.number().int().optional(),
      source: Source.optional(),
    })
    .strict(),
  Chart: z
    .object({
      kind: z.enum(["line", "bar", "area", "donut"]),
      xKey: z.string(),
      series: z.array(z.object({ key: z.string(), label: z.string() }).strict()),
      /**
       * Optional, like `Table.rows` and for the same two reasons: a producer
       * may legitimately have nothing to plot yet, and the agent path is not
       * allowed to write this at all — the hub fills it in from the tool call
       * the node cites, so the spec is briefly and correctly dataless.
       */
      data: z.array(z.record(z.unknown())).optional(),
      source: Source.optional(),
    })
    .strict(),
  Alert: z
    .object({ level: z.enum(["info", "success", "warning", "error"]), title: z.string().optional(), message: z.string() })
    .strict(),
  EmptyState: z
    .object({
      title: z.string(),
      message: z.string().optional(),
      action: ActionRef.optional(),
      /**
       * What the action's button should say. Optional because the catalog is
       * additive-only and `action` shipped without it; a satellite that sets
       * `action` should set this too, or the hub falls back to wording that
       * describes nothing in particular.
       */
      actionLabel: z.string().optional(),
    })
    .strict(),
  Timeline: z
    .object({
      items: z.array(
        z
          .object({
            timestamp: z.string(),
            label: z.string(),
            description: z.string().optional(),
            tone: Tone.optional(),
          })
          .strict(),
      ),
    })
    .strict(),

  // -- Input (13) ----------------------------------------------------------
  Form: z
    .object({ actionId: z.string(), submitLabel: z.string().optional(), confirm: Confirm.optional() })
    .strict(),
  TextField: field({ value: z.string().optional(), placeholder: z.string().optional() }),
  TextArea: field({ value: z.string().optional(), rows: z.number().int().optional() }),
  NumberField: field({
    value: z.number().optional(),
    // Data, not schema constraints — the hub renders them as input bounds.
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
  }),
  Select: field({ options: z.array(Option), value: z.string().optional() }),
  MultiSelect: field({ options: z.array(Option), value: z.array(z.string()).optional() }),
  DateField: field({ value: z.string().optional() }),
  DateRange: field({ from: z.string().optional(), to: z.string().optional() }),
  Checkbox: field({ checked: z.boolean().optional() }),
  Switch: field({ checked: z.boolean().optional() }),
  RadioGroup: field({ options: z.array(Option), value: z.string().optional() }),
  FileUpload: field({ accept: z.array(z.string()).optional(), multiple: z.boolean().optional() }),
  Hidden: z.object({ name: z.string(), value: z.string() }).strict(),

  // -- Action (3) ----------------------------------------------------------
  Button: z
    .object({
      label: z.string(),
      variant: z.enum(["primary", "secondary", "danger", "ghost"]).optional(),
      size: Size.optional(),
      disabled: z.boolean().optional(),
      action: ActionRef.optional(),
      confirm: Confirm.optional(),
    })
    .strict(),
  Link: z
    .object({
      label: z.string(),
      screenId: z.string().optional(),
      satelliteId: z.string().optional(),
      params: z.record(z.string()).optional(),
      /** Only ever an absolute http(s) URL, and rendered as leaving the portal. */
      href: z
        .string()
        .refine(isHttpUrl, "href must be an absolute http(s) URL")
        .optional(),
    })
    .strict(),
  MenuButton: z
    .object({
      label: z.string(),
      items: z.array(
        z
          .object({ label: z.string(), action: ActionRef.optional(), screenId: z.string().optional() })
          .strict(),
      ),
    })
    .strict(),
} as const;

export type ComponentName = keyof typeof COMPONENTS;

export const COMPONENT_NAMES = Object.keys(COMPONENTS) as ComponentName[];

const NAME_SET: ReadonlySet<string> = new Set<string>(COMPONENT_NAMES);

export function isComponentName(value: string): value is ComponentName {
  return NAME_SET.has(value);
}

export function propsSchemaFor(name: string): z.ZodTypeAny | undefined {
  return isComponentName(name) ? COMPONENTS[name] : undefined;
}
