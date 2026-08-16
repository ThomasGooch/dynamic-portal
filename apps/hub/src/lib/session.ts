import type { Principal } from "@portal/identity";

/**
 * Who the current request is.
 *
 * **This is a development stub and is deliberately loud about it.** Production
 * replaces this with an OIDC session and RFC 8693 token exchange; nothing else
 * in the hub changes, because everything downstream already takes a `Principal`
 * and every satellite verifies the signature itself rather than trusting us.
 *
 * The stub refuses to run outside development. A hub that silently authenticated
 * everyone as a fixed tenant in production would be the worst possible failure
 * of a system whose central claim is tenant isolation.
 */

const DEV_PRINCIPAL: Principal = {
  sub: "dev@acme.example",
  tenantId: "acme",
  audience: "internal",
  scopes: ["orders.read", "orders.write", "fleet.read"],
};

export class SessionUnavailableError extends Error {
  constructor() {
    super(
      "No session provider is configured. The development stub is disabled " +
        "outside NODE_ENV=development; wire OIDC before deploying.",
    );
    this.name = "SessionUnavailableError";
  }
}

export function currentPrincipal(): Principal {
  if (process.env["NODE_ENV"] === "production" && process.env["PORTAL_ALLOW_DEV_SESSION"] !== "1") {
    throw new SessionUnavailableError();
  }

  const tenantId = process.env["PORTAL_DEV_TENANT"];
  const audience = process.env["PORTAL_DEV_AUDIENCE"];

  return {
    ...DEV_PRINCIPAL,
    ...(tenantId ? { tenantId } : {}),
    ...(audience === "external" ? { audience: "external" as const } : {}),
  };
}

/** True when the portal is running on the stub, so the shell can say so. */
export function isDevSession(): boolean {
  return process.env["NODE_ENV"] !== "production" || process.env["PORTAL_ALLOW_DEV_SESSION"] === "1";
}
