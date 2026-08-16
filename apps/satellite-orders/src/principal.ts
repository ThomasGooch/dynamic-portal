import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AudienceSchema } from "@portal/protocol";

/**
 * The satellite verifies the identity it is handed. It does not trust the hub.
 *
 * This is the architecture's central security claim: authorization lives in the
 * satellite, so a hub bug is an availability incident rather than a cross-tenant
 * disclosure. That is only true if the satellite actually checks the signature —
 * hence this module rather than a header the caller could simply assert.
 *
 * The prototype uses a shared HMAC secret. Production swaps this for verifying
 * an RFC 8693 exchanged token against the issuer's JWKS; the call sites and the
 * `Principal` shape do not change.
 */

export const PrincipalSchema = z
  .object({
    sub: z.string().min(1),
    tenantId: z.string().min(1),
    audience: AudienceSchema,
    scopes: z.array(z.string().min(1)),
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
  return createHmac("sha256", secret).update(payload).digest("base64url");
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
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new InvalidPrincipalError("signature mismatch");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new InvalidPrincipalError("payload is not JSON");
  }

  const parsed = PrincipalSchema.safeParse(decoded);
  if (!parsed.success) throw new InvalidPrincipalError("payload is not a principal");
  return parsed.data;
}
