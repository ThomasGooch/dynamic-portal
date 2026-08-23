import { z } from "zod";

/**
 * Which org roles may see or do a thing.
 *
 * Roles come from the identity provider (Keycloak realm roles) and travel on
 * the Principal. A satellite *declares* which roles a screen or action is for;
 * the hub *decides*; the platform registry may *narrow* but never widen; each
 * satellite re-checks. Roles are the coarse "who" axis — org function — a
 * deliberate complement to `scopes`, which stay the fine-grained capability
 * axis (writes, tools).
 *
 * Two semantics set roles apart from `audience`, and both matter for safety:
 *
 *  - **Any-of, not all-of.** A caller passes a role check by holding *one* of
 *    the declared roles (people carry one org role), whereas every declared
 *    *scope* is required. See `hasAnyRole`.
 *
 *  - **Opt-in, not default-deny.** `audience` absent means a concrete
 *    `["internal"]` — silence fails closed. A role list absent means *no role
 *    constraint at all* — open to every authenticated role, still bounded by
 *    audience and scope. This is the inverse of audience on purpose: role
 *    gating is added to a screen deliberately, and every screen that predates
 *    roles keeps working untouched. The corollary is a footgun worth stating
 *    out loud: for roles, "forgot to declare" is NOT "locked down".
 */
export const RoleSchema = z.enum(["leadership", "engineering", "finance", "platform"]);
export type Role = z.infer<typeof RoleSchema>;

/**
 * Every role, frozen — for filtering an IdP's role claim (which also carries
 * built-ins like `offline_access`) down to the ones this system understands.
 */
export const ALL_ROLES: readonly Role[] = Object.freeze([
  "leadership",
  "engineering",
  "finance",
  "platform",
] as const);

/**
 * A role allow-list on a screen, action, satellite, or tool.
 *
 * Optional: absent means "not role-gated" (see the opt-in note above). When
 * present it must be non-empty — an empty array reads as an accident, and its
 * only coherent meaning ("nobody") is never what a hand-written declaration
 * intends. An effective empty set can still arise from *narrowing* two disjoint
 * lists, and that one does mean nobody; that is the entitlement layer's
 * concern, not a value anyone writes here.
 */
export const RoleListSchema = z
  .array(RoleSchema)
  .nonempty("roles must not be empty; omit the field to leave a resource un-gated")
  .optional();

/** True when the principal holds at least one of the target's roles (any-of). */
export function hasAnyRole(
  principalRoles: readonly Role[],
  targetRoles: readonly Role[],
): boolean {
  return targetRoles.some((role) => principalRoles.includes(role));
}

/** True when every role in `subset` is also declared by `superset`. */
export function isRoleSubset(subset: readonly Role[], superset: readonly Role[]): boolean {
  return subset.every((role) => superset.includes(role));
}
