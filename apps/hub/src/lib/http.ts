import type { Failure } from "@portal/registry";

/**
 * The two things every proxying route in the hub has to get right, in one place.
 *
 * Both were written once for the action route and then needed again by the
 * public façade. A second copy of either is a second chance to get it wrong:
 * one that buffers before it counts, or one that reports a timed-out write as
 * a gateway error a client is entitled to retry.
 */

/**
 * A payload larger than this is refused before it is proxied.
 *
 * Without it the hub will forward whatever it is handed, which makes it a
 * convenient amplifier pointed at an internal service that is not on the
 * network the caller can otherwise reach. 256 KB is far past any form, and far
 * past any partner submission.
 */
export const MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * The ceiling for a submission that carries a file.
 *
 * A separate number, because the reason for the small one does not apply: 256
 * KB is "far past any form" precisely because a form is text. A purchase order
 * scanned to PDF is not, and refusing it would make `FileUpload` a component
 * that renders and cannot be used.
 *
 * Ten megabytes is a document, not a video. It is also the point past which
 * buffering in the hub stops being reasonable — this reads the body to check
 * it before forwarding, which is simple and honest at this size and would need
 * to become a streaming proxy at a hundred times it.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

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
 *
 * Returns `null` when the limit was exceeded.
 */
export async function readBounded(request: Request, limit: number): Promise<string | null> {
  const bytes = await readBoundedBytes(request, limit);
  return bytes === null ? null : new TextDecoder("utf-8").decode(bytes);
}

/**
 * The same bounded read, stopping at the bytes.
 *
 * The multipart path needs these rather than a string: a `Request` built over
 * a bounded buffer can be handed to the platform's own `formData()` parser,
 * which is how the parse gets a ceiling. Calling `formData()` on the incoming
 * request instead buffers whatever arrives *before* anything can object — a
 * `content-length` check does not save it, because a chunked request declares
 * no length at all, and a 600 MB body measurably moved this hub's resident set
 * by 1.3 GB before the route returned its 413.
 */
export async function readBoundedBytes(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  // Refused from the header when there is one, which costs nothing.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;

  if (request.body === null) return new Uint8Array(0);

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

  // Copied into an `ArrayBuffer` of its own rather than handed out as a view
  // over Node's pooled buffer: the result is passed straight to a `Request`
  // body, and `BodyInit` wants a buffer this owns.
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * How an upstream failure reaches the caller.
 *
 * The distinctions matter to anyone writing a client: 503 and 504 are worth
 * retrying and 502 is not, and a timed-out write specifically must not be
 * reported as "the gateway failed", because the satellite may well have applied
 * it. Collapsing the lot to 502 tells a partner to retry a charge.
 */
export function statusFor(failure: Failure): number {
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
