import { actionInvoke, authorize } from "@portal/identity";
import { findSatellite } from "@portal/registry";
import type { Failure } from "@portal/registry";
import type { ActionApiResult } from "@/lib/actionApi";
import {
  MAX_PAYLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  readBounded,
  readBoundedBytes,
  statusFor,
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

  /**
   * The declaration is resolved *before* the body is read, because it is what
   * decides which ceiling applies.
   *
   * Read the other way round — the order this was written in — the ceiling
   * follows the request's own `content-type`, so any action at all could be
   * posted as multipart and spend the upload budget instead of the form one.
   * That was not theoretical: `orders.delete` accepted a 2 MB multipart body
   * and forwarded it, forty times what the action can possibly need, at an
   * internal service the caller cannot otherwise reach. Which is precisely the
   * amplifier `MAX_PAYLOAD_BYTES` exists to deny.
   *
   * It also means an action nobody may call, or one the manifest never
   * declared, is refused before a byte of its body is buffered.
   */
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

  const tooLarge: ActionApiResult = {
    ok: false,
    reason: "too-large",
    message: "That submission is too large to send.",
  };

  const unreadable: ActionApiResult = {
    ok: false,
    reason: "bad-request",
    message: "The portal could not read that submission.",
  };

  // Case-insensitive: `Multipart/Form-Data` is the same media type, and a
  // branch that turns on capitalisation is a branch two components will
  // eventually disagree about.
  const multipart = (request.headers.get("content-type") ?? "")
    .toLowerCase()
    .trimStart()
    .startsWith("multipart/form-data");

  // The action's own declaration, not the caller's header, is what grants the
  // larger ceiling.
  const declaresFile = (declared.params ?? []).some((param) => param.type === "file");

  if (multipart && !declaresFile) {
    return json(
      {
        ok: false,
        reason: "unsupported-media-type",
        message: "That action does not accept a file.",
      },
      415,
    );
  }

  let payload: unknown;

  if (multipart) {
    // Read under the ceiling first, parsed second. `request.formData()` on the
    // incoming request buffers whatever arrives before anything can object,
    // and a `content-length` check does not save it — a chunked request
    // declares no length at all. `readBoundedBytes` stops at the limit, and
    // the parse then runs over a buffer that is already known to be small
    // enough, so the decoded total needs no separate check.
    const bytes = await readBoundedBytes(request, MAX_UPLOAD_BYTES);
    if (bytes === null) return json(tooLarge, 413);

    try {
      // The platform's own multipart parser, reached by wrapping the bounded
      // buffer in a `Request`. The content-type is carried over rather than
      // reconstructed, because the boundary lives in it.
      payload = await new Request("http://hub.invalid/", {
        method: "POST",
        headers: { "content-type": request.headers.get("content-type") ?? "" },
        body: bytes,
      }).formData();
    } catch {
      return json(unreadable, 400);
    }
  } else {
    const raw = await readBounded(request, MAX_PAYLOAD_BYTES);
    if (raw === null) return json(tooLarge, 413);

    try {
      payload = raw === "" ? {} : JSON.parse(raw);
    } catch {
      return json(unreadable, 400);
    }
  }

  // An object, specifically: the satellites read named fields, and an array or
  // a bare string would arrive as something none of them expect. A `FormData`
  // is an object and passes, which is what lets it through to the proxy.
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return json(unreadable, 400);
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
        params: auditableParams(payload),
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
 * What the audit record digests for a submission.
 *
 * A `FormData` has no own enumerable properties, so the canonicaliser walks it
 * to `{}` — every upload would then share one digest with every other upload
 * and with an empty payload, which is the single property the record depends
 * on. Flattened to a plain object instead: the fields as they were sent, and a
 * file described by what it was rather than by its bytes, which are not the
 * hub's to keep.
 */
function auditableParams(payload: unknown): unknown {
  if (!(payload instanceof FormData)) return payload;

  // Null-prototype: a field named `__proto__` must land as a key, not as an
  // assignment through the prototype chain.
  const out = Object.create(null) as Record<string, unknown>;
  for (const [name, value] of payload.entries()) {
    const described =
      value instanceof File
        ? { filename: value.name, contentType: value.type, bytes: value.size }
        : value;
    // One name can carry several values — a multi-select, or a `multiple`
    // upload — and collapsing them would digest two different submissions the
    // same way.
    const existing = out[name];
    if (!Object.hasOwn(out, name)) out[name] = described;
    else if (Array.isArray(existing)) existing.push(described);
    else out[name] = [existing, described];
  }
  return out;
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
