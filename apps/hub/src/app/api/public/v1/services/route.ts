import { buildCatalog } from "@portal/public-api";
import { publicEntries, publicFailure, publicJson } from "@/lib/publicApi";
import { currentPrincipal } from "@/lib/session";

/**
 * The catalog, as a partner sees it.
 *
 * Everything here is a public name. If an internal id ever appears in this
 * response, the decoupling has failed and a satellite team can no longer rename
 * a screen without breaking someone outside the organization.
 */
export async function GET(): Promise<Response> {
  let principal;
  try {
    principal = currentPrincipal();
  } catch {
    return publicJson(publicFailure("unauthenticated"), 401);
  }

  return publicJson(buildCatalog(await publicEntries(), principal), 200);
}
