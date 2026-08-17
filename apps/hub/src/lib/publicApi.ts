import type { Principal } from "@portal/identity";
import type { CatalogEntry } from "@portal/public-api";
import { getPortal } from "./portal";

/**
 * The satellite/manifest pairs the public façade projects from.
 *
 * Every satellite in the registry is offered to the projection, not only the
 * ones already marked external — the filtering belongs in one place, and that
 * place is `@portal/public-api`, which is also where it is tested. A second
 * filter here would be a second chance to get the rule wrong, on the surface
 * where getting it wrong is a disclosure.
 */
export async function publicEntries(): Promise<CatalogEntry[]> {
  const portal = getPortal();

  const entries = await Promise.all(
    portal.registry.map(async (satellite) => {
      const manifest = await portal.clientFor(satellite).fetchManifest();
      return manifest.ok ? { satellite, manifest: manifest.value } : undefined;
    }),
  );

  return entries.filter((entry): entry is CatalogEntry => entry !== undefined);
}

/** Hub-authored copy. A partner never sees a satellite's own error text. */
export function publicFailure(reason: string): { readonly error: string } {
  return { error: reason };
}

export function publicJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Tenant-scoped, and an operation's outcome is never cacheable.
      "cache-control": "no-store",
    },
  });
}

/**
 * The principal for a brokered request.
 *
 * Today this is the same development stub the screens use, which means the
 * public API is only as authenticated as the rest of the prototype. Production
 * replaces it with partner credentials — an API key or client-credentials
 * grant — exchanged for a principal with `audience: "external"`. Nothing below
 * changes when it does, because everything below already takes a `Principal`.
 */
export type { Principal };
