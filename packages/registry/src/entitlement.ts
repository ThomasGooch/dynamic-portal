import { authorize, type Principal } from "@portal/identity";
import type { Audience } from "@portal/protocol";
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
}

export interface Entitlement {
  readonly allowed: boolean;
  /** The audience every layer agreed on. Empty means reachable by nobody. */
  readonly audience: readonly Audience[];
  /** Every scope any layer demanded, deduplicated. */
  readonly rbacScopes: readonly string[];
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
export function combine(layers: readonly EntitlementLayer[]): {
  readonly audience: readonly Audience[];
  readonly rbacScopes: readonly string[];
} {
  if (layers.length === 0) return { audience: [], rbacScopes: [] };

  const [outermost, ...rest] = layers as [EntitlementLayer, ...EntitlementLayer[]];

  return {
    // Ordered by the outermost layer so callers get a stable list to serialise.
    audience: outermost.audience.filter((value) =>
      rest.every((layer) => layer.audience.includes(value)),
    ),
    rbacScopes: [...new Set(layers.flatMap((layer) => layer.rbacScopes ?? []))],
  };
}

export function entitle(
  principal: Principal,
  layers: readonly EntitlementLayer[],
): Entitlement {
  if (layers.length === 0) {
    // An empty list describes nothing, and the safe reading of nothing is not
    // "everyone".
    return { allowed: false, audience: [], rbacScopes: [], reason: "nothing was declared" };
  }

  const { audience, rbacScopes } = combine(layers);

  if (audience.length === 0) {
    return {
      allowed: false,
      audience,
      rbacScopes,
      reason: "the declarations agree on no audience",
    };
  }

  const decision = authorize(principal, { audience, rbacScopes });
  return {
    allowed: decision.allowed,
    audience,
    rbacScopes,
    ...(decision.allowed ? {} : { reason: decision.reason }),
  };
}

/**
 * The registry's policy for one tool, or nothing.
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
