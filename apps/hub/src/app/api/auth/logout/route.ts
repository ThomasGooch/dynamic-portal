import { NextResponse, type NextRequest } from "next/server";
import * as client from "openid-client";
import { getOidcConfig, oidcConfigured } from "@/lib/oidc";
import { SESSION_COOKIE } from "@/lib/session";

/**
 * Clear the session and, when OIDC is configured, end the Keycloak session too
 * (RP-initiated logout) so a re-login is a real re-authentication rather than a
 * silent single-sign-on back into the same account.
 *
 * POST, not GET. A GET logout is reachable by any page on the internet — an
 * `<img src="https://portal/api/auth/logout">` on a forum signs a reader out
 * of the portal. Nothing is disclosed by that, but being logged out at random
 * by someone else's markup is a defect.
 *
 * POST alone does NOT fix it: a cross-origin HTML form POST is a "simple
 * request", needs no preflight, and any page can auto-submit one. So the
 * origin is checked as well. `Sec-Fetch-Site` is the reliable signal — every
 * browser that can reach this route sends it — and `Origin` is the fallback
 * for anything that does not. A request that proves neither is refused rather
 * than trusted, because the only cost of being wrong is that someone clicks
 * the button again.
 *
 * The response is still a redirect, so the browser lands on Keycloak's end
 * session endpoint exactly as before — POST changes who can start it, not
 * where it goes. 303 is what turns the POST into a GET for that landing.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const home = new URL("/", request.url).href;

  const fetchSite = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  const sameOrigin =
    fetchSite === "same-origin" ||
    (fetchSite === null && origin !== null && origin === new URL(request.url).origin);
  if (!sameOrigin) {
    // Deliberately not a redirect: a cross-site caller must learn nothing
    // about whether there was a session to end.
    return NextResponse.json({ error: "cross-site request refused" }, { status: 403 });
  }

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

  // 303: the browser must follow with GET. A default 307 would repeat the
  // POST at Keycloak's end-session endpoint, which does not accept one.
  const response = NextResponse.redirect(target, 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
