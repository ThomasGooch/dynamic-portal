import { createHash } from "node:crypto";
import { cache } from "react";
import { cookies } from "next/headers";
import { EncryptJWT, jwtDecrypt } from "jose";
import { PrincipalSchema, type Principal } from "@portal/identity";
import { RoleSchema, type Role } from "@portal/protocol";

/**
 * Who the current request is.
 *
 * Two providers, tried in order: a real OIDC session cookie (set by
 * `/api/auth/callback` after Keycloak login), then — only when explicitly
 * enabled — a development stub. Everything downstream already takes a
 * `Principal` and every satellite verifies the signature itself, so neither
 * provider is trusted further than the identity it yields.
 *
 * The stub refuses to run outside development. A hub that silently authenticated
 * everyone as a fixed tenant in production would be the worst possible failure
 * of a system whose central claim is tenant isolation — so the OIDC path is the
 * only one that runs there, and it fails closed when unconfigured.
 */

export const SESSION_COOKIE = "portal_session";
/** Short-lived cookie holding the PKCE verifier, state, and nonce between login and callback. */
export const OIDC_TX_COOKIE = "portal_oidc_tx";

const DEV_PRINCIPAL: Principal = {
  sub: "dev@acme.example",
  tenantId: "acme",
  audience: "internal",
  scopes: ["orders.read", "orders.write", "fleet.read", "depots.read", "depots.write"],
  // The stub carries every role so a default dev run sees the whole portal.
  // Narrow it with PORTAL_DEV_ROLES to act as one org role. The real OIDC login
  // sources roles from Keycloak instead (see lib/oidc.ts).
  roles: ["leadership", "engineering", "finance", "platform"],
};

export class SessionUnavailableError extends Error {
  constructor() {
    super(
      "No session provider is configured. The development stub is disabled " +
        "outside NODE_ENV=development; wire OIDC (PORTAL_OIDC_*) before deploying.",
    );
    this.name = "SessionUnavailableError";
  }
}

/**
 * Parse PORTAL_DEV_ROLES ("finance,leadership") into a validated role list.
 *
 * Unknown tokens are dropped rather than throwing: this is a developer switch,
 * and a typo should narrow the session, not crash the hub. Empty or
 * whitespace-only is treated as unset (docker-compose passes `${VAR:-}`, an
 * empty string when the host var is unset), keeping the stub's full role set
 * rather than collapsing the whole portal to nothing.
 */
function parseDevRoles(raw: string | undefined): Role[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const roles: Role[] = [];
  for (const token of raw.split(",")) {
    const parsed = RoleSchema.safeParse(token.trim());
    if (parsed.success) roles.push(parsed.data);
  }
  return roles;
}

function devPrincipal(): Principal {
  const tenantId = process.env["PORTAL_DEV_TENANT"];
  const audience = process.env["PORTAL_DEV_AUDIENCE"];
  const roles = parseDevRoles(process.env["PORTAL_DEV_ROLES"]);
  return {
    ...DEV_PRINCIPAL,
    ...(tenantId ? { tenantId } : {}),
    ...(audience === "external" ? { audience: "external" as const } : {}),
    ...(roles !== undefined ? { roles } : {}),
  };
}

/** The symmetric key for the session cookie, derived from the deploy secret. */
function sessionKey(): Uint8Array {
  const secret = process.env["PORTAL_SESSION_SECRET"];
  if (!secret) {
    throw new Error("PORTAL_SESSION_SECRET is required to read or write a session");
  }
  return createHash("sha256").update(secret).digest();
}

/** Encrypt a principal into a compact JWE for the session cookie. */
export async function encryptSession(principal: Principal): Promise<string> {
  return new EncryptJWT({ principal })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime("8h")
    .encrypt(sessionKey());
}

export interface OidcTx {
  readonly verifier: string;
  readonly state: string;
  readonly nonce: string;
}

/** Seal the login transaction (PKCE verifier, state, nonce) into a short-lived JWE. */
export async function sealTx(tx: OidcTx): Promise<string> {
  return new EncryptJWT({ ...tx })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .encrypt(sessionKey());
}

/** Open a sealed login transaction, or undefined when absent/tampered/expired. */
export async function openTx(token: string | undefined): Promise<OidcTx | undefined> {
  if (token === undefined) return undefined;
  try {
    const { payload } = await jwtDecrypt(token, sessionKey());
    const { verifier, state, nonce } = payload as Record<string, unknown>;
    if (typeof verifier === "string" && typeof state === "string" && typeof nonce === "string") {
      return { verifier, state, nonce };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** The principal from the session cookie, or undefined when absent/invalid. */
const readSession = cache(async function readSession(): Promise<Principal | undefined> {
  try {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (token === undefined) return undefined;
    const { payload } = await jwtDecrypt(token, sessionKey());
    const parsed = PrincipalSchema.safeParse(payload["principal"]);
    return parsed.success ? parsed.data : undefined;
  } catch {
    // A tampered, expired, or wrong-key cookie is simply no session — as is a
    // context with no request scope at all (a unit test invoking a route
    // handler directly). Either way the caller falls through to the dev stub or
    // a 401, never to a partial identity. `cookies()` is inside the try for the
    // second case.
    return undefined;
  }
});

/**
 * Whether the caller is signed in for real, as opposed to riding the dev stub.
 *
 * Not the same question as `!isDevSession()`: `NODE_ENV=development` makes that
 * true even for a developer who has actually logged in through Keycloak, and
 * such a person has a session to end. This asks the only thing that decides
 * whether signing out does anything — is there a cookie to clear.
 *
 * Shares one decryption with `currentPrincipal`: `readSession` is wrapped in
 * React's `cache`, which memoises per request. Without it the layout — which
 * calls both — decrypted the session cookie twice on every page render.
 */
export async function hasSession(): Promise<boolean> {
  return (await readSession()) !== undefined;
}

export async function currentPrincipal(): Promise<Principal> {
  const session = await readSession();
  if (session !== undefined) return session;

  // Allow-list, not a deny-list: `!== "development"` rather than
  // `=== "production"`. A staging deploy run with NODE_ENV unset is exactly the
  // case a deny-list misses, and missing it means silently authenticating every
  // visitor as one fixed tenant.
  if (isDevSession()) return devPrincipal();

  throw new SessionUnavailableError();
}

/** True when the portal is running on the stub, so the shell can say so. */
export function isDevSession(): boolean {
  return process.env["NODE_ENV"] === "development" || process.env["PORTAL_ALLOW_DEV_SESSION"] === "1";
}
