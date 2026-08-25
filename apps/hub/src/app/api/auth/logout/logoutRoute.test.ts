import { describe, expect, it, vi } from "vitest";

/**
 * Signing out, and who is allowed to start it.
 *
 * The route had no test. It is a state change reachable without any body or
 * token, so the only thing standing between it and any page on the internet is
 * the origin check — and an untested check is a check that quietly stops
 * holding the first time someone tidies the header names.
 *
 * OIDC is left unconfigured here on purpose: `oidcConfigured()` is false
 * without the env, so the route clears the cookie and redirects home without
 * reaching Keycloak. The branch under test is the refusal, which happens
 * before any of that.
 */
vi.mock("@/lib/oidc", () => ({
  oidcConfigured: () => false,
  getOidcConfig: async () => {
    throw new Error("not configured");
  },
}));

const { POST } = await import("./route");

const post = (headers: Record<string, string>) =>
  POST(
    new Request("https://portal.example/api/auth/logout", {
      method: "POST",
      headers,
    }) as never,
  );

describe("signing out", () => {
  it("accepts a same-origin form post", async () => {
    const response = await post({ "sec-fetch-site": "same-origin" });

    // 303 so the browser follows with GET; a 307 would repeat the POST at the
    // end-session endpoint, which does not accept one.
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://portal.example/");
  });

  it("clears the session cookie on the way out", async () => {
    const response = await post({ "sec-fetch-site": "same-origin" });
    expect(response.headers.get("set-cookie") ?? "").toContain("portal_session=");
  });

  it("refuses a cross-site post, which is the whole point of the check", async () => {
    // The attack this exists for: an auto-submitting form on any other page.
    // A cross-origin form POST is a "simple request" — no preflight, no
    // consent — so POST alone never prevented this.
    const response = await post({ "sec-fetch-site": "cross-site" });

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a same-site post from another subdomain", async () => {
    // `same-site` is not `same-origin`: a sibling host under the same
    // registrable domain sends this, and it is not the portal.
    expect((await post({ "sec-fetch-site": "same-site" })).status).toBe(403);
  });

  it("falls back to Origin when Sec-Fetch-Site is absent", async () => {
    expect((await post({ origin: "https://portal.example" })).status).toBe(303);
    expect((await post({ origin: "https://evil.example" })).status).toBe(403);
  });

  it("refuses a request that proves neither header", async () => {
    // Default deny: a caller that says nothing about where it came from has
    // not shown it is the portal, and the cost of being wrong is one more
    // click on a button.
    expect((await post({})).status).toBe(403);
  });
});
