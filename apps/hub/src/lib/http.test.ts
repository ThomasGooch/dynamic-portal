import { describe, expect, it } from "vitest";
import { MAX_PAYLOAD_BYTES, readBounded, statusFor } from "./http";

/** A request whose body streams in chunks and declares no `content-length`. */
function chunked(parts: readonly string[]): Request {
  const encoder = new TextEncoder();
  return new Request("http://hub.test/x", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    }),
    // Undici requires this for a streaming body and does not set it itself.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function declared(body: string, contentLength: number): Request {
  return new Request("http://hub.test/x", {
    method: "POST",
    body,
    headers: { "content-length": String(contentLength) },
  });
}

describe("reading a body without trusting it", () => {
  it("returns a body inside the limit", async () => {
    await expect(readBounded(chunked(['{"a":1}']), 1000)).resolves.toBe('{"a":1}');
  });

  it("refuses on a declared content-length, before reading anything", async () => {
    await expect(readBounded(declared("x".repeat(50), 5000), 100)).resolves.toBeNull();
  });

  it("refuses a chunked body that declares nothing", async () => {
    // The case a `content-length` check alone never covered, and the reason
    // this streams rather than calling `request.text()`. A sender who omits the
    // header — or understates it — is refused by the count off the wire.
    const parts = Array.from({ length: 20 }, () => "y".repeat(50));
    await expect(readBounded(chunked(parts), 100)).resolves.toBeNull();
  });

  it("counts bytes off the wire, not UTF-16 characters", async () => {
    // Three bytes each, one `String.length` unit each. A character count would
    // credit this at a third of its weight and let it through.
    const wide = "《".repeat(50); // 150 bytes, length 50
    expect(wide.length).toBe(50);
    expect(Buffer.byteLength(wide, "utf8")).toBe(150);

    await expect(readBounded(chunked([wide]), 100)).resolves.toBeNull();
    await expect(readBounded(chunked([wide]), 200)).resolves.toBe(wide);
  });

  it("decodes a multi-byte character split across two chunks", async () => {
    // Decoding per chunk would produce two replacement characters here.
    const encoded = new TextEncoder().encode("《");
    const request = new Request("http://hub.test/x", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded.slice(0, 1));
          controller.enqueue(encoded.slice(1));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readBounded(request, 100)).resolves.toBe("《");
  });

  it("allows exactly the limit and refuses one byte more", async () => {
    await expect(readBounded(chunked(["z".repeat(100)]), 100)).resolves.toBe("z".repeat(100));
    await expect(readBounded(chunked(["z".repeat(101)]), 100)).resolves.toBeNull();
  });

  it("treats an absent body as empty rather than as a violation", async () => {
    await expect(readBounded(new Request("http://hub.test/x"), 100)).resolves.toBe("");
  });

  it("caps at something far past a real payload and far short of a denial", () => {
    expect(MAX_PAYLOAD_BYTES).toBe(256 * 1024);
  });
});

describe("how an upstream failure reaches the caller", () => {
  it("keeps retryable and non-retryable apart", () => {
    // A timed-out write must not be reported as "the gateway failed": the
    // satellite may well have applied it, and 502 tells a partner to retry.
    expect(statusFor({ ok: false, reason: "timeout" })).toBe(504);
    expect(statusFor({ ok: false, reason: "unavailable", retryAfterMs: 5000 })).toBe(503);
    expect(statusFor({ ok: false, reason: "upstream-error", status: 500 })).toBe(502);
    expect(statusFor({ ok: false, reason: "invalid-response", detail: "bad shape" })).toBe(502);
    expect(statusFor({ ok: false, reason: "not-found" })).toBe(404);
    expect(statusFor({ ok: false, reason: "forbidden" })).toBe(403);
  });
});
