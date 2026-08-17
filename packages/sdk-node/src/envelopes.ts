import {
  ActionResponseSchema,
  CURRENT_PROTOCOL_VERSION,
  ManifestSchema,
  ScreenResponseSchema,
  type ActionResponse,
  type Manifest,
  type ScreenResponse,
  type UiNode,
} from "@portal/protocol";

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
  constructor(what: string, issues: readonly { path: string; message: string }[]) {
    super(
      `this ${what} does not satisfy the protocol: ` +
        issues.map((issue) => `${issue.path || "(root)"} ${issue.message}`).join("; "),
    );
    this.name = "InvalidEnvelopeError";
  }
}

const check = <T>(
  what: string,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: { issues: { path: (string | number)[]; message: string }[] } } },
  value: unknown,
): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidEnvelopeError(
      what,
      (parsed.error?.issues ?? []).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return parsed.data as T;
};

export interface ScreenInput {
  readonly id: string;
  readonly title: string;
  readonly ui: UiNode;
  readonly breadcrumbs?: readonly { readonly label: string; readonly screenId?: string }[];
  readonly ttlSeconds?: number;
  readonly etag?: string;
}

export function screen(input: ScreenInput): ScreenResponse {
  return check<ScreenResponse>("screen", ScreenResponseSchema, {
    protocol: CURRENT_PROTOCOL_VERSION,
    screen: {
      id: input.id,
      title: input.title,
      ...(input.breadcrumbs === undefined ? {} : { breadcrumbs: input.breadcrumbs }),
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
  readonly message?: string;
  readonly patch?: readonly { readonly targetId: string; readonly ui: UiNode }[];
  readonly navigate?: {
    readonly screenId: string;
    readonly satelliteId?: string;
    readonly params?: Readonly<Record<string, string>>;
  };
}

/**
 * A successful action.
 *
 * A patch may only be sent when every route to this action is on the screen the
 * patch addresses — an action does not learn which screen invoked it. PLAN.md
 * carries that as a known limit; this is where a satellite author meets it.
 */
export function ok(input: OkInput = {}): ActionResponse {
  return check<ActionResponse>("action response", ActionResponseSchema, {
    protocol: CURRENT_PROTOCOL_VERSION,
    outcome: "ok",
    ...(input.message === undefined
      ? {}
      : { toast: { level: "success" as const, message: input.message } }),
    ...(input.patch === undefined ? {} : { patch: input.patch }),
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
  message?: string,
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
  readonly description?: string;
  readonly audience?: readonly ("internal" | "external")[];
  readonly screens: readonly Record<string, unknown>[];
  readonly actions?: readonly Record<string, unknown>[];
  readonly nav?: readonly Record<string, unknown>[];
  readonly mcpUrl?: string;
  readonly healthPath?: string;
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
  });
}
