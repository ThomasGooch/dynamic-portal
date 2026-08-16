import { authorize } from "@portal/identity";
import { findSatellite } from "@portal/registry";
import type { Failure } from "@portal/registry";
import type { ActionApiResult } from "@/lib/actionApi";
import { getPortal } from "@/lib/portal";
import { currentPrincipal } from "@/lib/session";

/**
 * The write half of the proxy.
 *
 * Everything the screen route does before fetching, this does before invoking:
 * the satellite has to exist, be visible to this principal, and declare the
 * action — and the action has to be one this principal's audience may call. An
 * action the manifest does not declare is refused here rather than forwarded,
 * so the satellite's action surface is exactly what it published.
 *
 * The browser never learns whether a satellite exists but is off-limits: an
 * unknown satellite and a forbidden one answer identically, the same rule the
 * screen route follows and for the same reason.
 */

/**
 * A payload larger than this is refused before it is proxied.
 *
 * Without it the hub will forward whatever it is handed, which makes it a
 * convenient amplifier pointed at an internal service that is not on the
 * network the caller can otherwise reach. 256 KB is far past any form.
 */
const MAX_PAYLOAD_BYTES = 256 * 1024;

const NOT_FOUND: ActionApiResult = {
  ok: false,
  reason: "not-found",
  message: "That action is not available.",
};

/**
 * Reads the body, giving up as soon as it passes the limit.
 *
 * `request.text()` would buffer the whole thing first and only then let the
 * caller object, which pays exactly the cost the limit exists to avoid — and a
 * `content-length` check alone does not save it, because a chunked request has
 * no such header and a dishonest one can simply understate it.
 *
 * Counted in bytes off the wire, not in characters: `String.length` is UTF-16
 * code units, so a payload of non-ASCII text weighs up to twice what it would
 * be credited with.
 */
async function readBounded(request: Request, limit: number): Promise<string | null> {
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      // Stops the sender rather than reading to the end and discarding it.
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

function json(result: ActionApiResult, status: number): Response {
  return new Response(JSON.stringify(result), {
    status,
    headers: {
      "content-type": "application/json",
      // Nothing about an action's outcome is cacheable, and some of it is
      // tenant-scoped.
      "cache-control": "no-store",
    },
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ satelliteId: string; actionId: string }> },
): Promise<Response> {
  const { satelliteId, actionId } = await context.params;

  let principal;
  try {
    principal = currentPrincipal();
  } catch {
    return json(
      { ok: false, reason: "no-session", message: "You are not signed in." },
      401,
    );
  }

  const portal = getPortal();
  const satellite = findSatellite(portal.registry, satelliteId);
  if (
    satellite === undefined ||
    !authorize(principal, {
      audience: satellite.audience,
      rbacScopes: satellite.rbacScopes,
    }).allowed
  ) {
    return json(NOT_FOUND, 404);
  }

  const tooLarge: ActionApiResult = {
    ok: false,
    reason: "too-large",
    message: "That submission is too large to send.",
  };

  // Refused from the header when there is one, which costs nothing.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PAYLOAD_BYTES) {
    return json(tooLarge, 413);
  }

  const raw = await readBounded(request, MAX_PAYLOAD_BYTES);
  if (raw === null) return json(tooLarge, 413);

  let payload: unknown;
  try {
    payload = raw === "" ? {} : JSON.parse(raw);
  } catch {
    return json(
      { ok: false, reason: "bad-request", message: "The portal could not read that submission." },
      400,
    );
  }

  // An object, specifically: the satellites read named fields, and an array or
  // a bare string would arrive as something none of them expect.
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return json(
      { ok: false, reason: "bad-request", message: "The portal could not read that submission." },
      400,
    );
  }

  const client = portal.clientFor(satellite);

  const manifest = await client.fetchManifest();
  if (!manifest.ok) {
    return json(
      { ok: false, reason: manifest.reason, message: messageFor(satellite.displayName, manifest) },
      statusFor(manifest),
    );
  }

  const declared = manifest.value.actions.find((action) => action.id === actionId);
  if (
    declared === undefined ||
    !authorize(principal, { audience: declared.audience, rbacScopes: [] }).allowed
  ) {
    return json(NOT_FOUND, 404);
  }

  const result = await client.invokeAction(actionId, payload, principal);
  if (!result.ok) {
    return json(
      { ok: false, reason: result.reason, message: messageFor(satellite.displayName, result) },
      statusFor(result),
    );
  }

  return json({ ok: true, response: result.value }, 200);
}

/**
 * Hub-authored copy, never the satellite's own error text — that may carry
 * internal paths, and the proxy already withheld it once.
 */
function messageFor(name: string, failure: Failure): string {
  switch (failure.reason) {
    case "unavailable":
      return `${name} is not responding and the portal has stopped calling it for now. Nothing was changed.`;
    case "timeout":
      return `${name} took too long to answer. It may or may not have applied the change.`;
    case "not-found":
      return `${name} does not recognise that action.`;
    case "forbidden":
      return `${name} declined this request for your account.`;
    case "invalid-response":
      return `${name} answered in a way the portal cannot use. The change may have been applied.`;
    case "upstream-error":
      return `${name} reported an error and did not apply the change.`;
  }
}

function statusFor(failure: Failure): number {
  switch (failure.reason) {
    case "unavailable":
      return 503;
    case "timeout":
      return 504;
    case "not-found":
      return 404;
    case "forbidden":
      return 403;
    case "invalid-response":
    case "upstream-error":
      return 502;
  }
}
