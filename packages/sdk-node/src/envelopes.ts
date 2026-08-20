import {
  ActionDescriptorSchema,
  ActionResponseSchema,
  CURRENT_PROTOCOL_VERSION,
  ManifestSchema,
  NavEntrySchema,
  NavigateSchema,
  PatchSchema,
  ScreenDescriptorSchema,
  ScreenResponseSchema,
  type ActionResponse,
  type Audience,
  type Manifest,
  type ScreenResponse,
  type Summary,
} from "@portal/protocol";
import { validateNested } from "@portal/catalog";
import type { z } from "zod";

/**
 * The three envelopes, built rather than hand-written.
 *
 * Each of these carries the protocol version, which a satellite otherwise
 * copies into every response and eventually copies wrong — and each validates
 * before returning, so an incoherent combination fails in the satellite's own
 * tests rather than at the hub's edge.
 *
 * `ActionResponse` is the one that repays this most. Its coherence rules are
 * real and easy to violate: a `validation` outcome must carry field errors, a
 * failed outcome must not carry a patch. The builders below make the legal
 * combinations the only ones you can express, and the parse catches the rest.
 */

export class InvalidEnvelopeError extends Error {
  constructor(
    what: string,
    /** Kept, not just formatted: a caller that wants to point at the offending
     * field should not have to parse the message back apart. */
    readonly issues: readonly { path: string; message: string }[],
  ) {
    super(
      `this ${what} does not satisfy the protocol: ` +
        issues.map((issue) => `${issue.path || "(root)"} ${issue.message}`).join("; "),
    );
    this.name = "InvalidEnvelopeError";
  }
}

/**
 * Parse or throw.
 *
 * Typed on the schema rather than on an explicit type argument, so `T` is the
 * schema's own output and a builder cannot claim one envelope while validating
 * against another's schema.
 */
const check = <T>(what: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidEnvelopeError(
      what,
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
};

/**
 * Validates and discards the parse output, returning what it was handed.
 *
 * Zod's parse result is a deep copy, and the envelopes that carry a `UiNode`
 * carry a `Table` — so keeping it clones every row on every request, which is
 * the exact copy `ui.ts` goes out of its way not to make. Only safe where the
 * schema declares no defaults and no transforms, so the output is structurally
 * its input; `ManifestSchema` does declare them (`audience` defaults to
 * internal-only) and therefore still uses `check`.
 */
const checkInPlace = <T>(what: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: T): T => {
  check(what, schema, value);
  return value;
};

// Input shapes are derived from the protocol's own schemas rather than
// re-spelled here. A field added to a descriptor becomes expressible through
// the SDK without an edit, and one that changes shape is a compile error here
// rather than a runtime throw in a satellite.
type Breadcrumb = NonNullable<ScreenResponse["screen"]["breadcrumbs"]>[number];
type Patch = z.infer<typeof PatchSchema>;
type Navigate = z.infer<typeof NavigateSchema>;
type ScreenDescriptorInput = z.input<typeof ScreenDescriptorSchema>;
type ActionDescriptorInput = z.input<typeof ActionDescriptorSchema>;
type NavEntryInput = z.input<typeof NavEntrySchema>;

export interface ScreenInput {
  readonly id: string;
  readonly title: string;
  readonly ui: ScreenResponse["ui"];
  // Optionals are spelled `?: T | undefined` throughout, matching the protocol
  // package: under `exactOptionalPropertyTypes` a bare `?: T` would reject
  // `screen({ ..., etag })` for an `etag` the caller computed as possibly
  // absent, which is the normal way these values arise.
  readonly breadcrumbs?: readonly Breadcrumb[] | undefined;
  readonly ttlSeconds?: number | undefined;
  readonly etag?: string | undefined;
}

/**
 * A screen, validated against the catalog as well as the protocol.
 *
 * `ScreenResponseSchema` checks that the tree is structurally a tree; it does
 * not know the component vocabulary. A subtree that never went through `ui.*` —
 * a helper returning `UiNode`, a literal someone wrote in a hurry — would
 * otherwise pass here and be refused whole by the hub. The SDK's promise is
 * that a screen is valid before it leaves, so this closes the last way round
 * it.
 */
export function screen(input: ScreenInput): ScreenResponse {
  const catalog = validateNested(input.ui);
  if (!catalog.ok) {
    throw new InvalidEnvelopeError(
      "screen",
      catalog.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    );
  }

  return checkInPlace<ScreenResponse>("screen", ScreenResponseSchema, {
    protocol: CURRENT_PROTOCOL_VERSION,
    screen: {
      id: input.id,
      title: input.title,
      ...(input.breadcrumbs === undefined ? {} : { breadcrumbs: [...input.breadcrumbs] }),
    },
    ui: input.ui,
    ...(input.ttlSeconds === undefined && input.etag === undefined
      ? {}
      : {
          meta: {
            ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
            ...(input.etag === undefined ? {} : { etag: input.etag }),
          },
        }),
  });
}

export interface OkInput {
  readonly message?: string | undefined;
  /**
   * How the message reads. `success` announces that something changed;
   * `info` is for a success that merely restates the world — a refresh that
   * reloaded a table has not congratulated anyone.
   */
  readonly level?: "success" | "info" | undefined;
  readonly patch?: readonly Patch[] | undefined;
  readonly navigate?: Navigate | undefined;
}

/**
 * A successful action.
 *
 * A patch may only be sent when every route to this action is on the screen the
 * patch addresses — an action does not learn which screen invoked it. PLAN.md
 * carries that as a known limit; this is where a satellite author meets it.
 */
export function ok(input: OkInput = {}): ActionResponse {
  return checkInPlace<ActionResponse>("action response", ActionResponseSchema, {
    protocol: CURRENT_PROTOCOL_VERSION,
    outcome: "ok",
    ...(input.message === undefined
      ? {}
      : { toast: { level: input.level ?? "success", message: input.message } }),
    ...(input.patch === undefined ? {} : { patch: [...input.patch] }),
    ...(input.navigate === undefined ? {} : { navigate: input.navigate }),
  });
}

/** A refusal with nothing to attach to a field. */
export function failed(message: string): ActionResponse {
  return check<ActionResponse>("action response", ActionResponseSchema, {
    protocol: CURRENT_PROTOCOL_VERSION,
    outcome: "error",
    toast: { level: "error", message },
  });
}

/**
 * A refusal that names the fields at fault.
 *
 * The map has to be non-empty — an empty one is the `error` outcome above, and
 * the protocol says so rather than letting a satellite render a form with no
 * message on any field.
 */
export function invalid(
  fieldErrors: Readonly<Record<string, string>>,
  message?: string | undefined,
): ActionResponse {
  return check<ActionResponse>("action response", ActionResponseSchema, {
    protocol: CURRENT_PROTOCOL_VERSION,
    outcome: "validation",
    fieldErrors,
    ...(message === undefined ? {} : { toast: { level: "warning" as const, message } }),
  });
}

export interface ManifestInput {
  readonly satelliteId: string;
  readonly displayName: string;
  readonly description?: string | undefined;
  readonly audience?: readonly Audience[] | undefined;
  readonly screens: readonly ScreenDescriptorInput[];
  readonly actions?: readonly ActionDescriptorInput[] | undefined;
  readonly nav?: readonly NavEntryInput[] | undefined;
  readonly mcpUrl?: string | undefined;
  readonly healthPath?: string | undefined;
  /**
   * The screen whose stat tiles represent this satellite on the portal's front
   * page. Its figures are read from the screen itself, so there is nothing
   * extra to keep in step — and nothing to update when the screen changes.
   */
  readonly summary?: Summary | undefined;
}

/**
 * The declaration, with the protocol version filled in.
 *
 * Validated here so a satellite's own test suite fails on a manifest the hub
 * would disable it for — which is the difference between a five-minute fix and
 * a deployment that quietly serves nothing.
 */
export function manifest(input: ManifestInput): Manifest {
  return check<Manifest>("manifest", ManifestSchema, {
    protocol: CURRENT_PROTOCOL_VERSION,
    satelliteId: input.satelliteId,
    displayName: input.displayName,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.audience === undefined ? {} : { audience: input.audience }),
    screens: input.screens,
    actions: input.actions ?? [],
    ...(input.nav === undefined ? {} : { nav: input.nav }),
    ...(input.mcpUrl === undefined ? {} : { mcpUrl: input.mcpUrl }),
    ...(input.healthPath === undefined ? {} : { healthPath: input.healthPath }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
  });
}
