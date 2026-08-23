import { NextResponse, type NextRequest } from "next/server";
import * as client from "openid-client";
import { getOidcConfig, oidcConfigured } from "@/lib/oidc";
import { SESSION_COOKIE } from "@/lib/session";

/**
 * Clear the session and, when OIDC is configured, end the Keycloak session too
 * (RP-initiated logout) so a re-login is a real re-authentication rather than a
 * silent single-sign-on back into the same account.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const home = new URL("/", request.url).href;
  let target = home;

  if (oidcConfigured()) {
    try {
      const config = await getOidcConfig();
      target = client.buildEndSessionUrl(config, { post_logout_redirect_uri: home }).href;
    } catch {
      // If Keycloak is unreachable, clearing the local cookie is still the right
      // outcome — log the user out here and send them home.
    }
  }

  const response = NextResponse.redirect(target);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
