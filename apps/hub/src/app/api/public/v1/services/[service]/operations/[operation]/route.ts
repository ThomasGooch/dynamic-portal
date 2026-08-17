import { checkOperationParams, projectOperation, resolveOperation } from "@portal/public-api";
import { publicEntries, publicFailure, publicJson } from "@/lib/publicApi";
import { getPortal } from "@/lib/portal";
import { currentPrincipal } from "@/lib/session";

/** A partner's submission may not be larger than any form the portal renders. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * One operation, run.
 *
 * No confirmation gate here, and that is not an oversight: a confirmation is a
 * human deciding whether an *agent* should act. A partner calling this endpoint
 * is the human, and their own credentials already authorize it.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ service: string; operation: string }> },
): Promise<Response> {
  const { service, operation } = await context.params;

  let principal;
  try {
    principal = currentPrincipal();
  } catch {
    return publicJson(publicFailure("unauthenticated"), 401);
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return publicJson(publicFailure("payload too large"), 413);
  }

  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return publicJson(publicFailure("payload too large"), 413);
  }

  let body: unknown;
  try {
    body = raw === "" ? {} : JSON.parse(raw);
  } catch {
    return publicJson(publicFailure("body is not valid JSON"), 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return publicJson(publicFailure("body must be a JSON object"), 400);
  }

  const entries = await publicEntries();
  const resolved = resolveOperation(entries, principal, service, operation);
  if (resolved === undefined) return publicJson(publicFailure("not found"), 404);

  const checked = checkOperationParams(resolved.params, body as Record<string, unknown>);
  if (!checked.ok) return publicJson(publicFailure(checked.message), 400);

  const portal = getPortal();
  const satellite = portal.registry.find((entry) => entry.id === resolved.satelliteId);
  if (satellite === undefined) return publicJson(publicFailure("not found"), 404);

  const result = await portal
    .clientFor(satellite)
    .invokeAction(resolved.actionId, checked.value, principal);

  if (!result.ok) {
    return publicJson(publicFailure(result.reason), result.reason === "not-found" ? 404 : 502);
  }

  return publicJson(projectOperation(service, operation, result.value), 200);
}
