import { hasAnyRole, type Audience, type Role } from "@portal/protocol";
import type { Principal } from "./principal";

/**
 * The one place the allow/deny decision is expressed.
 *
 * Both satellites had already grown their own copy of this logic, which is how
 * two implementations of "default deny" start agreeing on the happy path and
 * differing on the edges. The decision lives here; enforcement still happens in
 * each satellite, because that separation is what keeps a hub bug from becoming
 * a disclosure.
 */

export interface AuthorizationTarget {
  /** Who this resource is exposed to. Empty means nobody — never everybody. */
  readonly audience: readonly Audience[];
  /** Every scope here is required, not any of them. */
  readonly rbacScopes: readonly string[];
  /**
   * Roles permitted, any-of. `undefined` means the resource is not role-gated
   * (audience and scope still apply) — the deliberate inverse of audience's
   * fail-closed default. An empty array, by contrast, means nobody: it only
   * ever arises from narrowing two disjoint role lists, and is honoured as-is.
   */
  readonly roles?: readonly Role[] | undefined;
}

export type AuthorizationResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly status: 403; readonly reason: string };

export function authorize(
  principal: Principal,
  target: AuthorizationTarget,
): AuthorizationResult {
  // Audience first, deliberately. A caller from the wrong audience should learn
  // nothing about which scopes a resource requires — the denial reason is a
  // side channel, however small.
  if (!target.audience.includes(principal.audience)) {
    return { allowed: false, status: 403, reason: "audience not permitted" };
  }

  // Roles are the internal org-RBAC axis — any-of and opt-in. Three conditions,
  // each deliberate:
  //  - internal only: org roles do not describe external partners, whose access
  //    is governed by audience + scopes + the public projection. Role-gating an
  //    external-facing satellite must never lock its partners out.
  //  - checked only when the target declares roles (undefined = un-gated).
  //  - after audience, so a wrong-audience caller learns nothing about roles.
  if (
    principal.audience === "internal" &&
    target.roles !== undefined &&
    !hasAnyRole(principal.roles ?? [], target.roles)
  ) {
    return { allowed: false, status: 403, reason: "role not permitted" };
  }

  for (const scope of target.rbacScopes) {
    if (!principal.scopes.includes(scope)) {
      return { allowed: false, status: 403, reason: `missing scope ${scope}` };
    }
  }

  return { allowed: true };
}
