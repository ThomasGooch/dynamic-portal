import { authorize, type Principal } from "@portal/identity";
import type { Audience, Role } from "@portal/protocol";
import type { Satellite } from "./registry";

/**
 * One function, because six call sites was six chances to forget.
 *
 * Every projection in this system answers the same question: given a satellite,
 * something declared inside it, and possibly a registry policy about that
 * thing, may this principal have it? The answer has two halves that are easy to
 * state and have been got wrong repeatedly:
 *
 *   - **Audience narrows.** The effective audience is the intersection of every
 *     enclosing layer. An inner declaration can never widen an outer one, so a
 *     screen marked external inside an internal-only satellite is visible to
 *     nobody.
 *   - **Scopes accumulate.** The effective requirement is the union. An inner
 *     policy adds a demand; it never relieves the caller of an outer one.
 *
 * Both rules were applied at call sites instead of to the class, and the
 * audience half was then missed in six separate files — the protocol's screen
 * check, the registry's tool check, the hub's per-screen enforcement, the
 * manifest-versus-registry check, the MCP gateway, and the public façade. Each
 * miss was found by review rather than by construction, and each fix was local,
 * which is precisely why there was always a next one.
 *
 * This does not remove the enforcement anywhere. Satellites still authorize
 * independently, which is what keeps a hub bug an availability incident rather
 * than a disclosure. It removes the *restatement*.
 */

export interface EntitlementLayer {
  /** Who this layer exposes its contents to. */
  readonly audience: readonly Audience[];
  /** Scopes this layer demands. Every one is required, not any. */
  readonly rbacScopes?: readonly string[];
  /**
   * Roles this layer permits (any-of). `undefined` means this layer imposes no
   * role constraint — it drops out of the narrowing entirely rather than
   * contributing an empty set. See `combine` for why that distinction matters.
   */
  readonly roles?: readonly Role[] | undefined;
}

export interface Entitlement {
  readonly allowed: boolean;
  /** The audience every layer agreed on. Empty means reachable by nobody. */
  readonly audience: readonly Audience[];
  /** Every scope any layer demanded, deduplicated. */
  readonly rbacScopes: readonly string[];
  /**
   * The roles every role-declaring layer agreed on (their intersection), or
   * `undefined` when no layer declared any. Empty means nobody — distinct from
   * `undefined`, which means un-gated.
   */
  readonly roles?: readonly Role[] | undefined;
  readonly reason?: string;
}

/**
 * The narrowing, without a principal.
 *
 * Separate because the MCP gateway builds its tool descriptors long before it
 * knows who is asking — a descriptor carries an effective audience and an
 * effective scope list, and `surface.ts` authorizes against them later. Both
 * halves of the rule still apply; only the final check is deferred.
 */
export function combine(layers: readonly (EntitlementLayer | undefined)[]): {
  readonly audience: readonly Audience[];
  readonly rbacScopes: readonly string[];
  readonly roles: readonly Role[] | undefined;
} {
  // `undefined` is accepted so a caller can pass an optional layer — a registry
  // tool policy that may not exist — without restating the "or nothing" branch
  // at every call site. That restatement is the thing this file exists to end.
  const declared = layers.filter((layer): layer is EntitlementLayer => layer !== undefined);
  const outermost = declared[0];
  if (outermost === undefined) return { audience: [], rbacScopes: [], roles: undefined };

  // Roles narrow like audience, with one difference that carries the whole
  // opt-in design: a layer that declares no roles is not "nobody", it is "no
  // opinion", so it drops out of the intersection rather than collapsing it to
  // empty. Only when at least one layer declares roles is there a ceiling; the
  // effective set is then the intersection of every declaring layer, ordered by
  // the first of them and deduped. An empty result there means the declaring
  // layers disagreed down to nobody — kept distinct from the `undefined` that
  // means un-gated, and honoured as fail-closed.
  const roleLayers = declared
    .map((layer) => layer.roles)
    .filter((roles): roles is readonly Role[] => roles !== undefined);
  const firstRoles = roleLayers[0];
  const roles =
    firstRoles === undefined
      ? undefined
      : firstRoles.filter(
          (value, at) =>
            firstRoles.indexOf(value) === at &&
            roleLayers.every((list) => list.includes(value)),
        );

  return {
    // Ordered by the outermost layer so callers get a stable list to serialise,
    // and deduplicated: nothing rejects an `[internal, internal]` declaration,
    // and a doubled entry would travel into a serialised tool descriptor.
    audience: outermost.audience.filter(
      (value, at) =>
        outermost.audience.indexOf(value) === at &&
        declared.every((layer) => layer.audience.includes(value)),
    ),
    rbacScopes: [...new Set(declared.flatMap((layer) => layer.rbacScopes ?? []))],
    roles,
  };
}

export function entitle(
  principal: Principal,
  layers: readonly (EntitlementLayer | undefined)[],
): Entitlement {
  const { audience, rbacScopes, roles } = combine(layers);

  if (audience.length === 0) {
    // Also the empty-list case: a list that declares nothing describes nothing,
    // and the safe reading of nothing is not "everyone".
    return {
      allowed: false,
      audience,
      rbacScopes,
      roles,
      reason: "the declarations agree on no audience",
    };
  }

  // `roles` is passed straight through: undefined means un-gated (authorize
  // skips it), an empty array means nobody, a list is any-of.
  const decision = authorize(principal, { audience, rbacScopes, roles });
  return {
    allowed: decision.allowed,
    audience,
    rbacScopes,
    roles,
    ...(decision.allowed ? {} : { reason: decision.reason }),
  };
}

/**
 * The satellite itself, as a layer.
 *
 * Every projection starts here, so the pair is named once rather than spelled
 * out in each of them — a projection that forgets `rbacScopes` while spelling
 * out `audience` is the same class of miss in a quieter form.
 */
export const satelliteLayer = (satellite: Satellite): EntitlementLayer => ({
  audience: satellite.audience,
  rbacScopes: satellite.rbacScopes,
  roles: satellite.roles,
});

/**
 * The registry's policy for one tool, or nothing.
 *
 * The result is itself an `EntitlementLayer`, so it can be handed straight to
 * `combine`/`entitle` — including when it is `undefined`.
 *
 * `hasOwn`, not bare bracket access: `tools` is a plain object and `constructor`
 * is a legal id, so `tools["constructor"]` resolves to the `Object` function.
 * Reading `rbacScopes` off that gives `undefined`, which a `?? []` then turns
 * into "no scopes required" — on whichever surface happened to do the lookup.
 * That has now been fixed twice in two files; it is one function so there is no
 * third.
 */
export function toolPolicy(
  satellite: Satellite,
  toolId: string,
): Satellite["tools"][string] | undefined {
  return Object.hasOwn(satellite.tools, toolId) ? satellite.tools[toolId] : undefined;
}
