import { NextResponse, type NextRequest } from "next/server";
import { decodeJwt } from "jose";
import * as client from "openid-client";
import { getOidcConfig, principalFromClaims, redirectUri, type OidcClaims } from "@/lib/oidc";
import { OIDC_TX_COOKIE, SESSION_COOKIE, encryptSession, openTx } from "@/lib/session";

/**
 * Finish the OIDC login: exchange the code, map the verified claims into a
 * Principal, and set the session cookie.
 *
 * Roles come from the access token's `realm_access.roles` (Keycloak does not put
 * them in the id_token); the id_token — signature-verified by openid-client —
 * supplies sub and tenant_id. Both are handed to the same `principalFromClaims`
 * that unit tests pin against a real token shape.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const tx = await openTx(request.cookies.get(OIDC_TX_COOKIE)?.value);
  // No transaction cookie means a stale or forged callback — start over rather
  // than attempt an exchange whose state and nonce cannot be checked.
  if (tx === undefined) {
    return NextResponse.redirect(new URL("/api/auth/login", request.url));
  }

  let sessionCookie: string;
  try {
    const config = await getOidcConfig();
    const tokens = await client.authorizationCodeGrant(config, new URL(request.url), {
      pkceCodeVerifier: tx.verifier,
      expectedState: tx.state,
      expectedNonce: tx.nonce,
    });

    const idClaims = (tokens.claims() ?? {}) as unknown as OidcClaims;
    const principal = principalFromClaims(idClaims, realmRoles(tokens.access_token));
    sessionCookie = await encryptSession(principal);
  } catch (error) {
    return NextResponse.json(
      { error: "login failed", detail: (error as Error).message },
      { status: 401 },
    );
  }

  const response = NextResponse.redirect(new URL("/", request.url));
  response.cookies.set(SESSION_COOKIE, sessionCookie, {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(redirectUri()).protocol === "https:",
    path: "/",
    maxAge: 8 * 60 * 60,
  });
  response.cookies.delete(OIDC_TX_COOKIE);
  return response;
}

/**
 * The realm roles from the access token.
 *
 * Decoded, not re-verified: the access token arrived in the same exchange whose
 * id_token openid-client just validated, so it is already trusted. Filtering to
 * the roles this system understands happens in `principalFromClaims`.
 */
function realmRoles(accessToken: string): string[] {
  try {
    const claims = decodeJwt(accessToken) as { realm_access?: { roles?: unknown } };
    const roles = claims.realm_access?.roles;
    return Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : [];
  } catch {
    return [];
  }
}
