import { z } from "zod";
import { AudienceListSchema, isAudienceSubset, type Audience } from "./audience";
import { ProtocolVersionSchema } from "./version";

/**
 * What a satellite declares about itself. This is the durable asset: the
 * capability declaration from which screens, agent tools, outward MCP, and the
 * public API are all projected.
 */

const IdSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-z0-9]+(?:[.\-_][a-z0-9]+)*$/,
    "ids are lower-kebab/dot segments, e.g. \"orders.list\"",
  );

/** Reports the index of the first repeated key, or -1 when all are unique. */
function firstDuplicateIndex(keys: readonly string[]): number {
  const seen = new Set<string>();
  for (const [index, key] of keys.entries()) {
    if (seen.has(key)) return index;
    seen.add(key);
  }
  return -1;
}

/**
 * Rejects a repeated key in a list, pointing the issue at the offending element
 * so the error names the item rather than the whole array.
 */
function rejectDuplicates<T>(label: string, keyOf: (item: T) => string) {
  return (items: readonly T[], ctx: z.RefinementCtx): void => {
    const keys = items.map(keyOf);
    const index = firstDuplicateIndex(keys);
    if (index >= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index],
        message: `duplicate ${label} "${keys[index]}"`,
      });
    }
  };
}

const rejectDuplicateIds = (label: string) =>
  rejectDuplicates<{ id: string }>(`${label} id`, (item) => item.id);

export const ScreenParamSchema = z
  .object({
    name: z.string().min(1),
    required: z.boolean().default(false),
    description: z.string().optional(),
  })
  .strict();

export const ScreenDescriptorSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1),
    description: z.string().optional(),
    params: z
      .array(ScreenParamSchema)
      // A repeated name is a silent data loss: the hub builds one input per
      // param and the last value wins, so the screen reads a param the caller
      // never meant to send.
      .superRefine(rejectDuplicates<{ name: string }>("param name", (p) => p.name))
      .optional(),
    audience: AudienceListSchema,
  })
  .strict();

/**
 * One input an action takes.
 *
 * Screens have declared their params since 1.0; actions have not, because the
 * hub only ever posted whatever a form happened to collect. That was enough
 * while a human filled the form in. An agent cannot fill in a shape nobody
 * described, so an action stays uncallable by the gateway until it says what it
 * takes — which is the honest failure, and better than letting a model guess
 * field names at a write endpoint.
 *
 * `type` is required here and absent from `ScreenParamSchema` for a real
 * reason: a screen param arrives in a query string and is therefore always a
 * string, while an action payload is JSON, where `{"quantity": 2}` and
 * `{"quantity": "2"}` are different values and the satellite receives whichever
 * the caller guessed.
 */
export const ActionParamSchema = z
  .object({
    name: z.string().min(1),
    /**
     * `string[]` is here because a form could express something the agent
     * surface could not.
     *
     * `MultiSelect` puts a list of strings on a screen, and until this existed
     * an action carrying one had no way to declare it — so an agent calling
     * that action simply omitted the field, and the satellite had to guess
     * whether "absent" meant "unchanged" or "cleared". In `orders` it meant a
     * model could strip the handling notes off a hazmat order and pass
     * validation, because the rule was judged against a list the caller never
     * sent.
     *
     * Deliberately not a general array type. A list of strings is what the
     * catalog's `MultiSelect` produces; anything richer invites nesting, and
     * nesting is what keeps a schema out of strict structured outputs.
     */
    type: z.enum(["string", "number", "boolean", "string[]"]),
    required: z.boolean().default(false),
    description: z.string().optional(),
    /** Enumerated choices, so an agent picks from a list rather than inventing one. */
    enum: z.array(z.string().min(1)).nonempty().optional(),
  })
  .strict()
  .superRefine((param, ctx) => {
    // Choices are strings, so they describe a string, or the elements of a
    // string list. On a number or a boolean they would describe a parameter no
    // value can satisfy, which reads as a callable action and is not one.
    if (param.enum !== undefined && param.type !== "string" && param.type !== "string[]") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enum"],
        message: `enumerated choices are only meaningful on a string or string[] parameter, not ${param.type}`,
      });
    }
  });

export const ActionDescriptorSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    params: z
      .array(ActionParamSchema)
      // The same silent data loss screens already guard against: one key, two
      // declarations, and a caller cannot tell which the satellite reads.
      .superRefine(rejectDuplicates<{ name: string }>("param name", (p) => p.name))
      .optional(),
    audience: AudienceListSchema,
  })
  .strict();

export const NavEntrySchema = z
  .object({
    screenId: IdSchema,
    label: z.string().min(1),
    section: z.string().min(1).optional(),
    order: z.number().int().optional(),
  })
  .strict();

/**
 * An absolute http(s) URL.
 *
 * `z.string().url()` only asks whether `new URL()` parses, which happily accepts
 * `javascript:`, `data:` and `file:` — so a satellite could publish an
 * `mcpUrl` the hub then hands to a fetcher or renders as a link.
 */
const HttpUrlSchema = z.string().url().refine((value) => {
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
}, "must be an http(s) URL");

/**
 * A path on the satellite's own origin.
 *
 * `startsWith("/")` alone admits `//evil.example` and `/\evil.example`, both of
 * which resolve to a *different host* when joined against the satellite base
 * with `new URL()`. The hub polls this path, so that is an SSRF the satellite
 * gets to choose.
 */
const OriginRelativePathSchema = z
  .string()
  .regex(/^\/(?![/\\])/, "must be a path on the satellite's own origin, e.g. \"/healthz\"");

export const ManifestSchema = z
  .object({
    protocol: ProtocolVersionSchema,
    satelliteId: IdSchema,
    displayName: z.string().min(1),
    description: z.string().optional(),
    audience: AudienceListSchema,
    screens: z.array(ScreenDescriptorSchema).superRefine(rejectDuplicateIds("screen")),
    actions: z.array(ActionDescriptorSchema).superRefine(rejectDuplicateIds("action")),
    nav: z.array(NavEntrySchema).optional(),
    /** Present when the satellite serves MCP natively; absent means the hub generates a shim. */
    mcpUrl: HttpUrlSchema.optional(),
    healthPath: OriginRelativePathSchema.optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    // Default-deny has to hold downwards too. Without this, a satellite
    // declaring itself ["internal"] could still mark a screen ["external"], and
    // a projection that filters on the screen's own audience — the natural
    // reading — would publish it outside the org.
    const declared: readonly Audience[] = manifest.audience;
    for (const [collection, items] of [
      ["screens", manifest.screens],
      ["actions", manifest.actions],
    ] as const) {
      items.forEach((item, index) => {
        if (!isAudienceSubset(item.audience, declared)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [collection, index, "audience"],
            message:
              `${collection.slice(0, -1)} "${item.id}" declares an audience the satellite does not: ` +
              `widen the satellite audience to ${JSON.stringify(item.audience)} first`,
          });
        }
      });
    }

    // A nav entry naming a screen that does not exist is a dead link the hub
    // only discovers when a user clicks it.
    const screenIds = new Set(manifest.screens.map((screen) => screen.id));
    manifest.nav?.forEach((entry, index) => {
      if (!screenIds.has(entry.screenId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nav", index, "screenId"],
          message: `nav entry references unknown screen "${entry.screenId}"`,
        });
      }
    });
  });

export type Manifest = z.infer<typeof ManifestSchema>;
export type ScreenDescriptor = z.infer<typeof ScreenDescriptorSchema>;
export type ActionDescriptor = z.infer<typeof ActionDescriptorSchema>;
export type ActionParam = z.infer<typeof ActionParamSchema>;
export type NavEntry = z.infer<typeof NavEntrySchema>;
