import * as client from "openid-client";
import { ALL_ROLES, type Role } from "@portal/protocol";
import { PrincipalSchema, type Principal } from "@portal/identity";

/**
 * The OIDC client — the hub's half of "the hub controls Auth".
 *
 * Production authentication: the user logs in at Keycloak, the hub exchanges the
 * code, and maps the verified claims into the very same `Principal` every
 * downstream call already takes. `packages/identity/src/principal.ts` reserved
 * exactly this slot ("Principal and every call site stay as they are"), so
 * nothing below the session boundary changes.
 *
 * The dev-session stub (`session.ts`) stays available behind its flag; this is
 * the real path it is replaced by.
 */

/** Configuration is discovered once and reused — the metadata changes on a Keycloak deploy, not per request. */
let configPromise: Promise<client.Configuration> | undefined;

export function oidcConfigured(): boolean {
  return (
    process.env["PORTAL_OIDC_ISSUER"] !== undefined &&
    process.env["PORTAL_OIDC_CLIENT_ID"] !== undefined &&
    process.env["PORTAL_OIDC_CLIENT_SECRET"] !== undefined
  );
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for OIDC login`);
  }
  return value;
}

export function redirectUri(): string {
  return process.env["PORTAL_OIDC_REDIRECT_URI"] ?? "http://localhost:3000/api/auth/callback";
}

/**
 * Bridge the browser-facing issuer host to the internal one, for server-side
 * calls only.
 *
 * In Docker the browser reaches Keycloak at `localhost:8080` (which must be the
 * issuer, so it matches token `iss` and the authorization redirect the browser
 * follows), but the hub container reaches it at `keycloak:8080`. This rewrites
 * the origin on the requests the hub itself makes — discovery, token exchange,
 * JWKS — while `buildAuthorizationUrl` still hands the browser the public
 * `localhost:8080` endpoint. Absent `PORTAL_OIDC_INTERNAL_ORIGIN` (e.g. local
 * `pnpm dev`), there is no rewrite.
 */
function bridgedFetch(): client.CustomFetch | undefined {
  const internal = process.env["PORTAL_OIDC_INTERNAL_ORIGIN"];
  const issuer = process.env["PORTAL_OIDC_ISSUER"];
  if (internal === undefined || issuer === undefined) return undefined;
  const browserOrigin = new URL(issuer).origin;
  const internalOrigin = new URL(internal).origin;
  return (url, options) => {
    const target = url.startsWith(browserOrigin)
      ? internalOrigin + url.slice(browserOrigin.length)
      : url;
    // openid-client's CustomFetchOptions is a superset of the DOM RequestInit;
    // it hands us exactly what it would give global fetch, so this cast is safe.
    return fetch(target, options as RequestInit);
  };
}

async function discover(): Promise<client.Configuration> {
  const issuer = new URL(required("PORTAL_OIDC_ISSUER"));
  const options: client.DiscoveryRequestOptions = {};
  const bridge = bridgedFetch();
  if (bridge !== undefined) options[client.customFetch] = bridge;
  // Keycloak on http (the local demo) would otherwise be refused; production
  // uses https and this branch never runs.
  if (issuer.protocol === "http:") options.execute = [client.allowInsecureRequests];
  return client.discovery(
    issuer,
    required("PORTAL_OIDC_CLIENT_ID"),
    required("PORTAL_OIDC_CLIENT_SECRET"),
    undefined,
    options,
  );
}

export async function getOidcConfig(): Promise<client.Configuration> {
  if (configPromise === undefined) {
    const attempt = discover();
    // Never memoise a failure: Keycloak may simply not be up yet on the first
    // login, and the next attempt should retry rather than replay a cached
    // rejection for the life of the process.
    attempt.catch(() => {
      if (configPromise === attempt) configPromise = undefined;
    });
    configPromise = attempt;
  }
  return configPromise;
}

/**
 * The scopes an authenticated internal principal is granted.
 *
 * Roles are the axis this login demonstrates; scopes remain the pre-existing
 * fine-grained gate and are not in the Keycloak token. Granting the standard
 * internal set keeps scope from silently blocking the demo while roles do the
 * visible gating — the same set the dev stub used. Real per-role or
 * claim-sourced scope provisioning is a follow-up; deliberately not invented here.
 */
const INTERNAL_SCOPES: readonly string[] = [
  "orders.read",
  "orders.write",
  "fleet.read",
  "depots.read",
  "depots.write",
];

/** The subset of an OIDC id_token's claims this hub reads. */
export interface OidcClaims {
  readonly sub?: string;
  readonly preferred_username?: string;
  readonly email?: string;
  /** From the realm's user-attribute mapper. */
  readonly tenant_id?: unknown;
  /** Optional: only an explicit "external" widens audience; anything else stays internal. */
  readonly portal_audience?: unknown;
}

/**
 * Map verified OIDC claims + the access token's realm roles into a `Principal`.
 *
 * Pure and exported so it is unit-testable against a real Keycloak token shape
 * without a browser. Two deliberate rules:
 *  - Roles are filtered to the four this system understands, dropping Keycloak
 *    built-ins (`offline_access`, `uma_authorization`, `default-roles-*`).
 *  - A missing/blank `tenant_id` is refused: a tenantless principal would defeat
 *    the isolation the whole design rests on, so login fails closed rather than
 *    inventing a tenant.
 */
export function principalFromClaims(
  idClaims: OidcClaims,
  realmRoles: readonly string[] | undefined,
): Principal {
  const sub = idClaims.sub ?? idClaims.preferred_username ?? idClaims.email;
  if (typeof sub !== "string" || sub === "") {
    throw new Error("OIDC token has no usable subject");
  }

  const tenantId = idClaims.tenant_id;
  if (typeof tenantId !== "string" || tenantId === "") {
    throw new Error("OIDC token has no tenant_id claim; refusing a tenantless principal");
  }

  const known = new Set<string>(ALL_ROLES);
  const roles = (realmRoles ?? []).filter((role): role is Role => known.has(role));

  const principal: Principal = {
    sub,
    tenantId,
    audience: idClaims.portal_audience === "external" ? "external" : "internal",
    scopes: [...INTERNAL_SCOPES],
    ...(roles.length > 0 ? { roles } : {}),
  };

  // Validate through the shared schema so an OIDC-minted principal is exactly
  // as strict as an HMAC-minted one — one definition of a valid identity.
  return PrincipalSchema.parse(principal);
}
