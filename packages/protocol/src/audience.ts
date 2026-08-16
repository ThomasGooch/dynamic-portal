import { z } from "zod";

/**
 * Who a satellite, screen, or tool may be exposed to.
 *
 * Default-deny is the most security-relevant rule in the protocol: a satellite
 * that forgets to declare an audience must never become externally visible.
 * Silence means internal-only, everywhere, without exception.
 */
export const AudienceSchema = z.enum(["internal", "external"]);
export type Audience = z.infer<typeof AudienceSchema>;

export const INTERNAL_ONLY: readonly Audience[] = Object.freeze(["internal"] as const);

/**
 * A non-empty audience list defaulting to internal-only.
 *
 * Empty is rejected rather than treated as "none": an empty array reads as an
 * accident, and we want the declaration to state its intent out loud.
 */
export const AudienceListSchema = z
  .array(AudienceSchema)
  .nonempty("audience must not be empty; declare [\"internal\"] explicitly")
  .default(["internal"]);
