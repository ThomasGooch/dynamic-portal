import { extractData } from "@portal/mcp-gateway";
import { checkResourceParams, projectResource, resolveResource } from "@portal/public-api";
import { publicEntries, publicFailure, publicJson } from "@/lib/publicApi";
import { getPortal } from "@/lib/portal";
import { currentPrincipal } from "@/lib/session";

/**
 * One resource, read.
 *
 * A screen underneath, and never visibly so: the response carries records and
 * a summary, not a UI tree. The extraction is the same one the agent path uses,
 * because "the data on this screen, without the layout" has one right answer.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ service: string; resource: string }> },
): Promise<Response> {
  const { service, resource } = await context.params;

  let principal;
  try {
    principal = currentPrincipal();
  } catch {
    return publicJson(publicFailure("unauthenticated"), 401);
  }

  const entries = await publicEntries();
  const resolved = resolveResource(entries, principal, service, resource);
  // Unknown and not-yours answer identically: a 403 would confirm that a
  // resource exists, which is the disclosure the whole audience model prevents.
  if (resolved === undefined) return publicJson(publicFailure("not found"), 404);

  const query: Record<string, unknown> = {};
  for (const [key, value] of new URL(request.url).searchParams) query[key] = value;

  const checked = checkResourceParams(resolved.params, query);
  if (!checked.ok) return publicJson(publicFailure(checked.message), 400);

  const portal = getPortal();
  const satellite = portal.registry.find((entry) => entry.id === resolved.satelliteId);
  if (satellite === undefined) return publicJson(publicFailure("not found"), 404);

  const screen = await portal
    .clientFor(satellite)
    .fetchScreen(resolved.screenId, checked.value as Record<string, string>, principal);

  if (!screen.ok) {
    return publicJson(publicFailure(screen.reason), screen.reason === "not-found" ? 404 : 502);
  }

  return publicJson(
    projectResource(service, resource, screen.value.screen.title, extractData(screen.value.ui)),
    200,
  );
}
