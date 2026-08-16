import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  ManifestSchema,
  ScreenResponseSchema,
  isSupportedProtocolVersion,
  parseProtocolVersion,
} from "@portal/protocol";
import type { Principal } from "@portal/identity";
import { loadRegistry } from "@portal/registry";
import { buildSurface } from "@portal/mcp-gateway";
import { CATALOG_VERSION, validateNested } from "@portal/catalog";

/**
 * Stack-level checks against the containers started by `pnpm up`.
 *
 * The distinction from the integration tier is real: those tests boot a server
 * in-process, so they verify the code. These reach a container over a published
 * port, so they verify the code *as deployed* — image, entrypoint, environment,
 * healthcheck and port mapping included. A green integration suite and a broken
 * Dockerfile is exactly the gap this tier closes.
 *
 * This tier is also the only place the polyglot claim is actually tested. The
 * fleet satellite is written in Python and shares no code with the protocol
 * package; parsing its responses with the TypeScript schemas is what turns
 * "any language can implement PUP" from an assertion into a passing test.
 */

const ORDERS = process.env["PORTAL_ORDERS_URL"] ?? "http://127.0.0.1:4001";
const FLEET = process.env["PORTAL_FLEET_URL"] ?? "http://127.0.0.1:4002";
const SECRET = process.env["PORTAL_PRINCIPAL_SECRET"] ?? "dev-only-not-a-real-secret";

/** Mints a principal the same way the hub's token exchange will. */
function principal(over: Record<string, unknown> = {}): string {
  const claims = {
    sub: "e2e@acme.example",
    tenantId: "acme",
    audience: "internal",
    scopes: ["orders.read", "orders.write", "fleet.read"],
    ...over,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${createHmac("sha256", SECRET).update(payload).digest("base64url")}`;
}

const bearer = (token = principal()) => ({ authorization: `Bearer ${token}` });

const SATELLITES = [
  { name: "satellite-orders", base: ORDERS, id: "orders", screen: "orders.list", lang: "TypeScript" },
  { name: "satellite-fleet", base: FLEET, id: "fleet", screen: "fleet.dashboard", lang: "Python" },
] as const;

for (const sat of SATELLITES) {
  test.describe(`${sat.name} (${sat.lang}), as deployed`, () => {
    test("reports healthy", async ({ request }) => {
      const res = await request.get(`${sat.base}/healthz`);
      expect(res.ok()).toBe(true);
      expect((await res.json()).status).toBe("ok");
    });

    test("serves a manifest that conforms to the published protocol", async ({ request }) => {
      const res = await request.get(`${sat.base}/portal/manifest`);
      expect(res.ok()).toBe(true);
      const manifest = ManifestSchema.parse(await res.json());
      expect(manifest.satelliteId).toBe(sat.id);
      expect(manifest.audience).toEqual(["internal"]);
    });

    test("serves a screen that conforms to the published protocol", async ({ request }) => {
      const res = await request.get(`${sat.base}/portal/screens/${sat.screen}`, {
        headers: bearer(),
      });
      expect(res.ok()).toBe(true);
      const screen = ScreenResponseSchema.parse(await res.json());
      expect(screen.ui.type).toBe("Page");
    });

    test("every node it emits is in the catalog vocabulary", async ({ request }) => {
      // The protocol only checks that a node is structurally a node. This is
      // the check that it is a *legal component with legal props* — and for
      // the Python satellite it is the only place that happens, since it
      // cannot import the TypeScript catalog. A satellite inventing a
      // component, or misspelling a tone, fails here rather than rendering as
      // an error placeholder in front of a user.
      const screen = ScreenResponseSchema.parse(
        await (
          await request.get(`${sat.base}/portal/screens/${sat.screen}`, { headers: bearer() })
        ).json(),
      );
      const result = validateNested(screen.ui);
      if (!result.ok) {
        throw new Error(
          `${sat.name} emits nodes outside catalog v${CATALOG_VERSION}:\n` +
            result.issues.map((i) => `  ${i.path}: ${i.message}`).join("\n"),
        );
      }
      expect(result.ok).toBe(true);
    });

    test("refuses tenant data without a principal", async ({ request }) => {
      expect((await request.get(`${sat.base}/portal/screens/${sat.screen}`)).status()).toBe(401);
    });

    test("refuses a forged principal", async ({ request }) => {
      const res = await request.get(`${sat.base}/portal/screens/${sat.screen}`, {
        headers: bearer("bm90LWEtdG9rZW4.forged"),
      });
      expect(res.status()).toBe(401);
    });

    test("refuses a validly signed principal from the wrong audience", async ({ request }) => {
      // The manifest declares internal-only. A correct signature is not enough.
      const res = await request.get(`${sat.base}/portal/screens/${sat.screen}`, {
        headers: bearer(principal({ audience: "external" })),
      });
      expect(res.status()).toBe(403);
    });
  });
}

test.describe("cross-satellite protocol agreement", () => {
  test("both satellites speak a version the hub supports, not the same one", async ({
    request,
  }) => {
    // This asserted the two versions were *identical* until 1.1 landed, and
    // then failed on a change the compatibility rule explicitly permits — a
    // minor bump that adds optional fields and asks no satellite to redeploy.
    // Requiring uniformity here would have made every future minor a
    // coordinated release of every satellite, which is the coupling the
    // protocol's N-2 rule exists to prevent.
    //
    // The stack now genuinely runs mixed: orders on 1.1, fleet still on 1.0.
    // That is the supported state, so it is the state the tests describe.
    const versions = await Promise.all(
      SATELLITES.map(async (s) =>
        ManifestSchema.parse(await (await request.get(`${s.base}/portal/manifest`)).json())
          .protocol,
      ),
    );

    for (const version of versions) {
      expect(isSupportedProtocolVersion(version), `${version} is unsupported`).toBe(true);
    }
    expect(new Set(versions.map((v) => parseProtocolVersion(v).major)).size).toBe(1);
  });

  test("at least one satellite ships no MCP server, so the shim stays exercised", async ({
    request,
  }) => {
    // fleet deliberately has no MCP server: it is the case that proves the
    // hub's PUP-to-MCP shim has something to do. If every satellite ever ships
    // MCP, the shim silently stops being exercised anywhere.
    //
    // Deliberately *not* asserting that some satellite ships MCP natively:
    // none does yet (orders' is planned), so such an assertion would have to be
    // written as something that cannot fail, which is worse than no test.
    const manifests = await Promise.all(
      SATELLITES.map(async (s) => ({
        id: s.id,
        manifest: ManifestSchema.parse(
          await (await request.get(`${s.base}/portal/manifest`)).json(),
        ),
      })),
    );
    const withoutMcp = manifests.filter((m) => m.manifest.mcpUrl === undefined);
    expect(withoutMcp.map((m) => m.id)).toContain("fleet");
  });

  test("neither satellite leaks a tenant discriminator into rendered rows", async ({ request }) => {
    for (const sat of SATELLITES) {
      const screen = ScreenResponseSchema.parse(
        await (
          await request.get(`${sat.base}/portal/screens/${sat.screen}`, { headers: bearer() })
        ).json(),
      );
      const rows = findRows(screen.ui);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).not.toHaveProperty("tenantId");
    }
  });
});

/** Collects the rows of the first Table in a screen. */
function findRows(node: { type: string; props?: Record<string, unknown>; children?: unknown[] }): Record<string, unknown>[] {
  if (node.type === "Table") return (node.props?.["rows"] as Record<string, unknown>[]) ?? [];
  for (const child of node.children ?? []) {
    const rows = findRows(child as typeof node);
    if (rows.length) return rows;
  }
  return [];
}

const HUB = process.env["PORTAL_HUB_URL"] ?? "http://127.0.0.1:3000";

test.describe("the hub, as deployed", () => {
  test("lists every satellite the principal may see", async ({ request }) => {
    const html = await (await request.get(`${HUB}/`)).text();
    expect(html).toContain("Order Management");
    expect(html).toContain("Fleet Operations");
  });

  test("renders a screen from the TypeScript satellite", async ({ request }) => {
    const html = await (await request.get(`${HUB}/orders`)).text();
    expect(html).toContain("orders-table");
  });

  test("renders a screen from the Python satellite", async ({ request }) => {
    // The same shell, the same vocabulary, a different language behind it —
    // which is the whole claim of the architecture in one assertion.
    const html = await (await request.get(`${HUB}/fleet`)).text();
    expect(html).toContain("fleet-table");
  });

  test("deep links carry parameters through to the satellite", async ({ request }) => {
    // Plain URLs with real history. PLAN.md verification #2, and the thing
    // iframes and micro-frontends make awkward.
    const res = await request.get(`${HUB}/orders/orders.detail?id=ord-1001`);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain("KeyValueList");
  });

  test("404s an unknown satellite rather than 403ing it", async ({ request }) => {
    // A 403 would confirm the satellite exists — the same disclosure the
    // satellites avoid on another tenant's records.
    expect((await request.get(`${HUB}/no-such-satellite`)).status()).toBe(404);
  });

  test("never serves a page that could have been prerendered", async ({ request }) => {
    // A statically prerendered page would bake one tenant's rows into HTML and
    // hand them to everyone. Next reports its rendering decision in this header.
    const res = await request.get(`${HUB}/orders`);
    expect(res.headers()["x-nextjs-prerender"]).toBeUndefined();
  });
});

test.describe("the agent-facing projection of the same declarations", () => {
  // The polyglot claim, on the agent path. `satellite-fleet` is Python, ships
  // no MCP server, and shares no code with any of these packages — so the tools
  // an agent would see there come entirely from the shim reading a manifest
  // written in another language. If this passes, "most satellites, not all" is
  // a tested statement rather than an intention.
  const agent: Principal = {
    sub: "agent@acme.example",
    tenantId: "acme",
    audience: "internal",
    scopes: ["orders.read", "orders.write", "fleet.read"],
  };

  const entry = async (id: string, base: string, extra = "") => {
    const satellite = loadRegistry(
      `- id: ${id}\n  displayName: ${id}\n  baseUrl: ${base}\n  owner: team\n  rbacScopes: [${id}.read]\n${extra}`,
      {},
    )[0];
    if (satellite === undefined) throw new Error(`no ${id}`);
    const manifest = ManifestSchema.parse(await (await fetch(`${base}/portal/manifest`)).json());
    return { satellite, manifest };
  };

  test("turns the Python satellite's screens into tools with no MCP server involved", async () => {
    const surface = buildSurface([await entry("fleet", FLEET)], agent);
    expect(surface.tools.map((tool) => tool.name).sort()).toEqual([
      "fleet__fleet_dashboard",
      "fleet__fleet_detail",
    ]);
    expect(surface.skipped).toEqual([]);
  });

  test("carries a declared screen param into the tool's input schema", async () => {
    const surface = buildSurface([await entry("fleet", FLEET)], agent);
    expect(surface.byName.get("fleet__fleet_detail")?.inputSchema).toEqual({
      type: "object",
      properties: { id: { type: "string", description: "Vehicle id" } },
      required: ["id"],
      additionalProperties: false,
    });
  });

  test("keeps two satellites' tools in separate namespaces", async () => {
    const surface = buildSurface(
      [
        await entry(
          "orders",
          ORDERS,
          "  tools:\n    orders.approve:\n      agentVisible: true\n      requiresConfirmation: true\n      rbacScopes: [orders.write]\n",
        ),
        await entry("fleet", FLEET),
      ],
      agent,
    );
    const names = surface.tools.map((tool) => tool.name);
    expect(names.filter((name) => name.startsWith("orders__")).length).toBeGreaterThan(0);
    expect(names.filter((name) => name.startsWith("fleet__")).length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  test("offers no write at all on a satellite that declares none", async () => {
    // Fleet is read-only. Nothing in the shim invents a mutation for it.
    const surface = buildSurface([await entry("fleet", FLEET)], agent);
    expect(surface.tools.every((tool) => tool.kind === "read")).toBe(true);
  });
});
