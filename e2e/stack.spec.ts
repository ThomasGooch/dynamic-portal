import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { ManifestSchema, ScreenResponseSchema } from "@portal/protocol";

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
  test("both satellites speak the same protocol version", async ({ request }) => {
    const versions = await Promise.all(
      SATELLITES.map(async (s) =>
        ManifestSchema.parse(await (await request.get(`${s.base}/portal/manifest`)).json())
          .protocol,
      ),
    );
    expect(new Set(versions).size).toBe(1);
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
