import { expect, test } from "@playwright/test";
import { ManifestSchema } from "@portal/protocol";

/**
 * Stack-level checks against the containers started by `pnpm up`.
 *
 * The distinction from the integration tier is real: those tests boot a server
 * in-process, so they verify the code. These reach a container over a published
 * port, so they verify the code *as deployed* — image, entrypoint, environment,
 * healthcheck and port mapping included. A green integration suite and a broken
 * Dockerfile is exactly the gap this tier closes.
 */

const ORDERS = process.env["PORTAL_ORDERS_URL"] ?? "http://127.0.0.1:4001";

test.describe("satellite-orders, as deployed", () => {
  test("reports healthy", async ({ request }) => {
    const res = await request.get(`${ORDERS}/healthz`);
    expect(res.ok()).toBe(true);
    expect((await res.json()).status).toBe("ok");
  });

  test("serves a manifest that conforms to the published protocol", async ({ request }) => {
    const res = await request.get(`${ORDERS}/portal/manifest`);
    expect(res.ok()).toBe(true);
    // Parsing with the real schema means a drifting satellite fails the build,
    // not a code review.
    expect(() => ManifestSchema.parse(res.json())).toBeDefined();
    const manifest = ManifestSchema.parse(await res.json());
    expect(manifest.satelliteId).toBe("orders");
    expect(manifest.audience).toEqual(["internal"]);
  });

  test("refuses tenant data without a principal", async ({ request }) => {
    const res = await request.get(`${ORDERS}/portal/screens/orders.list`);
    expect(res.status()).toBe(401);
  });

  test("refuses a forged principal", async ({ request }) => {
    const res = await request.get(`${ORDERS}/portal/screens/orders.list`, {
      headers: { authorization: "Bearer bm90LWEtdG9rZW4.forged" },
    });
    expect(res.status()).toBe(401);
  });
});
