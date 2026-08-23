import { NextResponse } from "next/server";
import * as client from "openid-client";
import { getOidcConfig, redirectUri } from "@/lib/oidc";
import { OIDC_TX_COOKIE, sealTx } from "@/lib/session";

/**
 * Start the OIDC login: PKCE + state + nonce, then redirect to Keycloak.
 *
 * The three secrets that tie this request to its callback ride in a short-lived,
 * encrypted, httpOnly cookie rather than server memory, so the flow survives a
 * hub with more than one instance.
 */
export async function GET(): Promise<NextResponse> {
  const config = await getOidcConfig();

  const verifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(verifier);
  const state = client.randomState();
  const nonce = client.randomNonce();

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(),
    scope: "openid profile email",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });

  const response = NextResponse.redirect(url.href);
  response.cookies.set(OIDC_TX_COOKIE, await sealTx({ verifier, state, nonce }), {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(redirectUri()).protocol === "https:",
    path: "/",
    maxAge: 600,
  });
  return response;
}
