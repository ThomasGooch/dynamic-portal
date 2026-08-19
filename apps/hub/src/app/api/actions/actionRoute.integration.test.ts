import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The hub's write proxy, over a real socket.
 *
 * This route had no test of any kind, which is how it shipped a multipart
 * branch whose size limit was chosen by the caller's own `content-type` and
 * whose parse had no ceiling at all. Both of those are decisions the route
 * makes *before* it forwards anything, so they cannot be covered from the
 * satellite's side or from a browser — the satellite never sees the requests
 * that matter here, because the point is that they are refused.
 *
 * Integration tier: it binds a port and writes an audit file.
 */

/** Every request the stub satellite was actually asked to perform. */
interface Received {
  readonly actionId: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly filename?: string;
  readonly fileBytes?: number;
}

let satellite: Server;
let received: Received[] = [];
let post: (
  actionId: string,
  init: { body: BodyInit | null; headers?: Record<string, string> },
) => Promise<{ status: number; body: { ok: boolean; reason?: string } }>;
let auditLines: () => { action: { actionId: string; paramsDigest: string } }[];

const MANIFEST = {
  protocol: "1.1",
  satelliteId: "stub",
  displayName: "Stub",
  audience: ["internal"],
  screens: [],
  actions: [
    {
      id: "stub.upload",
      title: "Upload",
      params: [
        { name: "id", type: "string", required: true },
        { name: "document", type: "file", required: true },
      ],
      audience: ["internal"],
    },
    {
      id: "stub.plain",
      title: "Plain",
      params: [{ name: "id", type: "string", required: true }],
      audience: ["internal"],
    },
  ],
};

beforeAll(async () => {
  satellite = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url === "/portal/manifest") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(MANIFEST));
        return;
      }

      const raw = Buffer.concat(chunks);
      const contentType = req.headers["content-type"] ?? "";
      const actionId = (req.url ?? "").split("/").pop() ?? "";

      const record = async (): Promise<void> => {
        const entry: Received = { actionId, contentType, bytes: raw.byteLength };
        if (contentType.startsWith("multipart/form-data")) {
          const form = await new Request("http://stub.invalid/", {
            method: "POST",
            headers: { "content-type": contentType },
            body: raw,
          }).formData();
          const file = form.get("document");
          if (file instanceof File) {
            received.push({ ...entry, filename: file.name, fileBytes: file.size });
            return;
          }
        }
        received.push(entry);
      };

      void record().then(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ protocol: "1.1", outcome: "ok" }));
      });
    });
  });

  await new Promise<void>((resolve) => satellite.listen(0, "127.0.0.1", resolve));
  const port = (satellite.address() as AddressInfo).port;

  const dir = mkdtempSync(join(tmpdir(), "portal-route-"));
  const registryPath = join(dir, "satellites.yaml");
  const logPath = join(dir, "audit.jsonl");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    registryPath,
    `- id: stub
  displayName: Stub
  baseUrl: http://127.0.0.1:${port}
  owner: test
  audience: [internal]
  timeoutMs: 5000
`,
  );

  // Set before the route is imported: `portal.ts` reads the registry path at
  // module scope, and `session.ts` decides there whether the dev stub is live.
  process.env["PORTAL_REGISTRY_PATH"] = registryPath;
  process.env["PORTAL_PRINCIPAL_SECRET"] = "test-secret";
  process.env["PORTAL_AUDIT_KEY"] = "test-audit-key";
  process.env["PORTAL_AUDIT_LOG"] = logPath;
  process.env["PORTAL_ALLOW_DEV_SESSION"] = "1";

  const route = await import("./[satelliteId]/[actionId]/route");

  post = async (actionId, init) => {
    const response = await route.POST(
      new Request(`http://hub.invalid/api/actions/stub/${actionId}`, {
        method: "POST",
        ...init,
        // Required by undici whenever the body is a stream.
        ...(init.body instanceof ReadableStream ? { duplex: "half" } : {}),
      } as RequestInit),
      { params: Promise.resolve({ satelliteId: "stub", actionId }) },
    );
    return { status: response.status, body: await response.json() };
  };

  auditLines = () =>
    readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
});

afterAll(() => {
  satellite.close();
});

beforeEach(() => {
  received = [];
});

const upload = (filename: string, size: number): FormData => {
  const form = new FormData();
  form.append("id", "ord-1001");
  form.append("document", new File([new Uint8Array(size)], filename, { type: "application/pdf" }));
  return form;
};

describe("which ceiling a submission gets", () => {
  it("lets a declared file through, with its bytes", async () => {
    const response = await post("stub.upload", { body: upload("po.pdf", 2048) });

    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.contentType).toMatch(/^multipart\/form-data/);
    expect(received[0]?.filename).toBe("po.pdf");
    // The bytes, not just the name — the whole claim the multipart path makes.
    expect(received[0]?.fileBytes).toBe(2048);
  });

  it("refuses multipart on an action that declares no file, before forwarding it", async () => {
    // The ceiling used to follow the request's own `content-type`, so any
    // action could be posted as multipart and spend forty times the payload
    // budget at an internal service the caller cannot otherwise reach.
    const form = new FormData();
    form.append("id", "ord-1001");
    form.append("junk", new File([new Uint8Array(512 * 1024)], "x.bin"));

    const response = await post("stub.plain", { body: form });

    expect(response.status).toBe(415);
    expect(received).toEqual([]);
  });

  it("holds a fileless action to the small cap", async () => {
    const response = await post("stub.plain", {
      body: JSON.stringify({ id: "x".repeat(300 * 1024) }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(413);
    expect(received).toEqual([]);
  });

  it("stops an oversized upload that declares no length at all", async () => {
    // A chunked request has no `content-length`, so a header check passes it
    // and the parse then buffers whatever arrives. Measured against the
    // running stack before this was fixed: 600 MB moved the hub's resident set
    // by 1.3 GB and *then* returned 413.
    let pushed = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Far past the 10 MB ceiling if it is allowed to run to completion.
        if (pushed >= 64) return controller.close();
        pushed += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });

    const response = await post("stub.upload", {
      body,
      headers: { "content-type": "multipart/form-data; boundary=----x" },
    });

    expect(response.status).toBe(413);
    expect(received).toEqual([]);
    // The read gave up rather than draining the sender: everything past the
    // ceiling was never asked for.
    expect(pushed).toBeLessThan(64);
  });

  it("refuses a body that is not the shape its content-type claims", async () => {
    const response = await post("stub.upload", {
      body: JSON.stringify({ id: "ord-1001" }),
      headers: { "content-type": "multipart/form-data; boundary=----x" },
    });

    expect(response.status).toBe(400);
    expect(received).toEqual([]);
  });
});

describe("what the audit records about an upload", () => {
  // A `FormData` has no own enumerable properties, so digesting it directly
  // walked it to `{}` — every upload sharing one digest with every other and
  // with an empty payload, which is the single property the record depends on.
  it("distinguishes two uploads that differ only in the file", async () => {
    // The log is append-only and earlier tests have already written to it.
    const before = auditLines().length;

    await post("stub.upload", { body: upload("first.pdf", 16) });
    await post("stub.upload", { body: upload("second.pdf", 16) });
    await post("stub.upload", { body: upload("first.pdf", 4096) });

    const digests = auditLines()
      .slice(before)
      .map((line) => line.action.paramsDigest);

    expect(digests).toHaveLength(3);
    expect(new Set(digests).size).toBe(3);
  });
});
