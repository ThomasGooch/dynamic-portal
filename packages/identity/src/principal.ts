import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AudienceSchema, RoleSchema } from "@portal/protocol";

/**
 * Who is asking, and on whose behalf.
 *
 * The hub authenticates and propagates this; every satellite verifies it
 * independently. The redundancy is the point: if authorization lived only in
 * the hub, one hub bug would be a cross-tenant disclosure across every
 * solution at once. With verification in the satellites, a hub bug is an
 * availability incident.
 *
 * The wire format is shared with the Python satellite —
 * base64url(JSON) "." base64url(HMAC-SHA256) — and a cross-language test in
 * both languages pins it. Verification runs over the payload *as received* and
 * never re-serialises: JSON key order differs between languages, so re-encoding
 * before comparing would break every cross-language token.
 *
 * The prototype uses a shared HMAC secret. Production verifies an RFC 8693
 * exchanged token against the issuer's JWKS; `Principal` and every call site
 * stay as they are.
 */

export const PrincipalSchema = z
  .object({
    sub: z.string().min(1),
    tenantId: z.string().min(1),
    audience: AudienceSchema,
    scopes: z.array(z.string().min(1)),
    // Org roles from the IdP (Keycloak realm roles). Optional, never required:
    // a token minted before roles existed — including the pinned cross-language
    // fixture — must still verify, and a satellite must be deployable ahead of
    // the hub that starts sending them. Absent is read as "holds no role"
    // (see `authorize`), so an un-role-gated resource is unaffected.
    roles: z.array(RoleSchema).optional(),
  })
  .strict();

export type Principal = z.infer<typeof PrincipalSchema>;

export class InvalidPrincipalError extends Error {
  constructor(reason: string) {
    super(`Invalid principal token: ${reason}`);
    this.name = "InvalidPrincipalError";
  }
}

function sign(payload: string, secret: string): string {
  // utf-8 throughout. The payload segment is attacker-controlled and arrives
  // decoded from a header, so an `ascii` encode would throw on any byte above
  // 0x7F — and a throw that is not an InvalidPrincipalError escapes the auth
  // layer as a 500 rather than a 401. The Python satellite had exactly that bug.
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

export function signPrincipal(principal: Principal, secret: string): string {
  const payload = Buffer.from(JSON.stringify(principal), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyPrincipal(token: string, secret: string): Principal {
  const parts = token.split(".");
  if (parts.length !== 2) throw new InvalidPrincipalError("expected <payload>.<signature>");

  const [payload, signature] = parts as [string, string];
  if (payload === "" || signature === "") throw new InvalidPrincipalError("empty segment");

  const expected = Buffer.from(sign(payload, secret), "utf8");
  const actual = Buffer.from(signature, "utf8");
  // Length first: timingSafeEqual throws on a length mismatch, which would be
  // an exception rather than a rejection.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new InvalidPrincipalError("signature mismatch");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new InvalidPrincipalError("payload is not JSON");
  }

  // `.strict()` matters: the Python implementation is strict too, and a token
  // that authenticates against one satellite while another refuses it is one
  // identity with two answers.
  const parsed = PrincipalSchema.safeParse(decoded);
  if (!parsed.success) throw new InvalidPrincipalError("payload is not a principal");
  return parsed.data;
}
