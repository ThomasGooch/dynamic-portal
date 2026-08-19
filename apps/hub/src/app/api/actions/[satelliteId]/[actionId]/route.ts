import { actionInvoke, authorize } from "@portal/identity";
import { findSatellite } from "@portal/registry";
import type { Failure } from "@portal/registry";
import type { ActionApiResult } from "@/lib/actionApi";
import {
  MAX_PAYLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  readBounded,
  statusFor,
  withinUploadLimit,
} from "@/lib/http";
import { auditKeyFor, auditStamp, recordAudit } from "@/lib/audit";
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

const NOT_FOUND: ActionApiResult = {
  ok: false,
  reason: "not-found",
  message: "That action is not available.",
};

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

  /**
   * Two shapes arrive here, and the size limit differs by an order of
   * magnitude between them.
   *
   * A JSON action is a form's worth of text and stays on the small cap. A
   * multipart action carries a file, and the reason the small cap exists —
   * "far past any form" — stops applying the moment the payload is a scanned
   * document. The type is read from the request rather than from the action's
   * declaration on purpose: the declaration is fetched below, and a caller
   * must not be able to pick which limit applies by naming an action.
   */
  const multipart = (request.headers.get("content-type") ?? "").startsWith("multipart/form-data");

  let payload: unknown;

  if (multipart) {
    if (!withinUploadLimit(request)) return json(tooLarge, 413);

    try {
      // Parsed rather than streamed through: the hub has to know a file is
      // what arrived before it forwards one, and at ten megabytes buffering
      // costs less than the machinery not to. `request.formData()` enforces
      // nothing about size itself, which is why the header is checked first
      // and the parsed total is checked after.
      const form = await request.formData();
      const total = [...form.values()].reduce(
        (sum, value) => sum + (value instanceof File ? value.size : value.length),
        0,
      );
      if (total > MAX_UPLOAD_BYTES) return json(tooLarge, 413);
      payload = form;
    } catch {
      return json(
        { ok: false, reason: "bad-request", message: "The portal could not read that submission." },
        400,
      );
    }
  } else {
    const raw = await readBounded(request, MAX_PAYLOAD_BYTES);
    if (raw === null) return json(tooLarge, 413);

    try {
      payload = raw === "" ? {} : JSON.parse(raw);
    } catch {
      return json(
        { ok: false, reason: "bad-request", message: "The portal could not read that submission." },
        400,
      );
    }
  }

  // An object, specifically: the satellites read named fields, and an array or
  // a bare string would arrive as something none of them expect. A `FormData`
  // is an object and passes, which is what lets it through to the proxy.
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

  const startedAt = Date.now();
  const result = await client.invokeAction(actionId, payload, principal);

  try {
    await recordAudit(
      actionInvoke({
        ...auditStamp(),
        principal,
        auditKey: auditKeyFor(principal),
        satelliteId: satellite.id,
        actionId,
        params: payload,
        outcome: result.ok
          ? { status: "ok" }
          : { status: "error", reason: result.reason, httpStatus: statusFor(result) },
        latencyMs: Date.now() - startedAt,
      }),
    );
  } catch {
    // Still fails closed — the caller is told the outcome is unknown rather
    // than told it succeeded. Answered in this route's own envelope, though:
    // letting the throw escape hands the browser Next's HTML error page, which
    // the renderer can only read as "could not reach this solution", and the
    // solution was reached. The action ran; only the record did not.
    return json(
      {
        ok: false,
        reason: "not-recorded",
        message:
          "The change could not be recorded, so the portal cannot confirm it. Check before retrying.",
      },
      500,
    );
  }

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
