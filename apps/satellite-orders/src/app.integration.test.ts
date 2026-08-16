import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ActionResponseSchema,
  ManifestSchema,
  ScreenResponseSchema,
} from "@portal/protocol";
import { createApp } from "./app.js";
import { signPrincipal, type Principal } from "./principal.js";
import { OrderRepository, seedOrders } from "./repository.js";

const SECRET = "integration-secret";

const principal = (over: Partial<Principal> = {}): Principal => ({
  sub: "alice@acme.example",
  tenantId: "acme",
  audience: "internal",
  scopes: ["orders.read", "orders.write"],
  ...over,
});

let server: Server;
let baseUrl: string;
let repository: OrderRepository;

beforeAll(async () => {
  repository = new OrderRepository(seedOrders());
  const app = createApp({ repository, principalSecret: SECRET });
  server = await new Promise<Server>((resolve) => {
    // Port 0 → the OS picks a free port, so suites never collide.
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function get(path: string, token?: string) {
  return fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function post(path: string, body: unknown, token?: string) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("protocol conformance over real HTTP", () => {
  // The satellite is checked against the *published* schemas, not against its
  // own idea of them. This is the conformance kit in miniature.
  it("serves a manifest that satisfies the published schema", async () => {
    const res = await get("/portal/manifest");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => ManifestSchema.parse(body)).not.toThrow();
  });

  it("serves a list screen that satisfies the published schema", async () => {
    const res = await get("/portal/screens/orders.list", signPrincipal(principal(), SECRET));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => ScreenResponseSchema.parse(body)).not.toThrow();
  });

  it("declares itself internal-only by default", async () => {
    const manifest = ManifestSchema.parse(await (await get("/portal/manifest")).json());
    expect(manifest.audience).toEqual(["internal"]);
  });
});

describe("authentication", () => {
  it("refuses an unauthenticated screen request", async () => {
    expect((await get("/portal/screens/orders.list")).status).toBe(401);
  });

  it("refuses a token signed with the wrong secret", async () => {
    const forged = signPrincipal(principal(), "wrong-secret");
    expect((await get("/portal/screens/orders.list", forged)).status).toBe(401);
  });

  it("serves the manifest unauthenticated — it carries no tenant data", async () => {
    expect((await get("/portal/manifest")).status).toBe(200);
  });

  it("accepts a lowercase bearer scheme — RFC 7235 makes it case-insensitive", async () => {
    const token = signPrincipal(principal(), SECRET);
    const res = await fetch(`${baseUrl}/portal/screens/orders.list`, {
      headers: { authorization: `bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("declared audience, enforced by the satellite", () => {
  // The manifest says internal-only. Default-deny is worth nothing if the
  // satellite parses the principal's audience and then ignores it: a validly
  // signed external principal would read internal tenant data.
  it("refuses a validly signed principal from an undeclared audience", async () => {
    const external = signPrincipal(principal({ audience: "external" }), SECRET);
    expect((await get("/portal/screens/orders.list", external)).status).toBe(403);
  });

  it("refuses an external principal's action even with the write scope", async () => {
    const external = signPrincipal(principal({ audience: "external" }), SECRET);
    const own = repository.list("acme")[0]!;
    expect(
      (await post("/portal/actions/orders.approve", { id: own.id }, external)).status,
    ).toBe(403);
  });
});

describe("tenant isolation enforced by the satellite itself", () => {
  // PLAN.md verification #7. The hub is not in this test at all: these requests
  // go straight to the satellite, which is precisely the point. If authorization
  // lived only in the hub, every assertion below would fail.
  it("returns only the calling tenant's rows", async () => {
    const res = await get("/portal/screens/orders.list", signPrincipal(principal(), SECRET));
    const body = ScreenResponseSchema.parse(await res.json());
    const table = findNode(body.ui, "Table");
    const rows = (table?.props?.["rows"] ?? []) as { tenantId?: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === undefined)).toBe(true);
  });

  it("gives two tenants different row counts or ids", async () => {
    const acme = ScreenResponseSchema.parse(
      await (await get("/portal/screens/orders.list", signPrincipal(principal(), SECRET))).json(),
    );
    const globex = ScreenResponseSchema.parse(
      await (
        await get(
          "/portal/screens/orders.list",
          signPrincipal(principal({ tenantId: "globex" }), SECRET),
        )
      ).json(),
    );
    const ids = (node: typeof acme.ui) =>
      ((findNode(node, "Table")?.props?.["rows"] ?? []) as { id: string }[]).map((r) => r.id);
    const acmeIds = new Set(ids(acme.ui));
    expect(ids(globex.ui).some((id) => acmeIds.has(id))).toBe(false);
  });

  it("404s another tenant's order rather than 403 — a 403 would confirm it exists", async () => {
    const foreign = repository.list("globex")[0]!;
    const res = await get(
      `/portal/screens/orders.detail?id=${foreign.id}`,
      signPrincipal(principal(), SECRET),
    );
    expect(res.status).toBe(404);
  });

  it("refuses to approve another tenant's order", async () => {
    const foreign = repository.list("globex").find((o) => o.status === "pending")!;
    const res = await post(
      "/portal/actions/orders.approve",
      { id: foreign.id },
      signPrincipal(principal(), SECRET),
    );
    expect(res.status).toBe(404);
    expect(repository.get("globex", foreign.id)?.status).toBe("pending");
  });
});

describe("action envelopes", () => {
  it("returns a schema-valid success with a toast and a patch", async () => {
    const own = repository.list("acme").find((o) => o.status === "pending")!;
    const res = await post(
      "/portal/actions/orders.approve",
      { id: own.id },
      signPrincipal(principal(), SECRET),
    );
    expect(res.status).toBe(200);
    const body = ActionResponseSchema.parse(await res.json());
    expect(body.outcome).toBe("ok");
    expect(body.toast?.level).toBe("success");
    expect(body.patch?.[0]?.targetId).toBe("orders-table");
  });

  it("returns a schema-valid validation failure carrying field errors", async () => {
    const res = await post(
      "/portal/actions/orders.approve",
      {},
      signPrincipal(principal(), SECRET),
    );
    expect(res.status).toBe(200);
    const body = ActionResponseSchema.parse(await res.json());
    expect(body.outcome).toBe("validation");
    expect(Object.keys(body.fieldErrors ?? {})).toContain("id");
  });

  it("requires the write scope to approve", async () => {
    const own = repository.list("acme")[0]!;
    const readOnly = signPrincipal(principal({ scopes: ["orders.read"] }), SECRET);
    expect(
      (await post("/portal/actions/orders.approve", { id: own.id }, readOnly)).status,
    ).toBe(403);
  });
});

/** Depth-first search for the first node of a given component type. */
function findNode(
  node: { type: string; props?: Record<string, unknown> | undefined; children?: unknown[] | undefined },
  type: string,
): { type: string; props?: Record<string, unknown> | undefined } | undefined {
  if (node.type === type) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child as typeof node, type);
    if (found) return found;
  }
  return undefined;
}
