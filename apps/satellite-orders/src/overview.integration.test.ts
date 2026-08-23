import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "@portal/identity";
import { extractData } from "@portal/mcp-gateway";
import { SatelliteClient, SatelliteSchema } from "@portal/registry";
import { createApp } from "./app";
import { OrderRepository, seedOrders } from "./repository";

/**
 * The front page's figures, against a real satellite over a real socket.
 *
 * The unit tests prove the rules with hand-written screens, which says nothing
 * about whether *this* satellite's actual manifest nominates a screen that
 * actually carries stat tiles. That chain — manifest declares `summary`, hub
 * fetches that screen, extractor recovers the tiles — has four places to break
 * and only one of them is in the hub.
 *
 * It is also the test that would fail if somebody redesigned `orders.list` and
 * dropped its tiles: the card would go quietly blank in production, and the
 * satellite's own suite is the right place to notice.
 *
 * Deliberately built from packages rather than by importing the hub's reader.
 * What is being asserted is *this satellite's* promise — that it nominates a
 * screen and that the screen carries figures — and a satellite reaching into
 * hub internals to check its own contract would be the coupling this whole
 * architecture is arranged to avoid. `extractData` is the same extractor the
 * hub runs, from the package both sides already share.
 */

const SECRET = "overview-integration-secret";

const principal: Principal = {
  sub: "dev@acme.example",
  tenantId: "acme",
  audience: "internal",
  scopes: ["orders.read", "orders.write"],
  roles: ["leadership", "engineering", "finance"],
};

let server: Server;
let client: SatelliteClient;

/** The same three steps the hub takes, in the same order, over the wire. */
async function overviewOf(who: Principal) {
  const manifest = await client.fetchManifest();
  if (!manifest.ok) throw new Error(`manifest: ${manifest.reason}`);

  const { healthPath, summary } = manifest.value;
  expect(healthPath, "this satellite should declare a health path").toBeDefined();
  expect(summary, "this satellite should nominate a summary screen").toBeDefined();

  const health = await client.checkHealth(healthPath!);
  const screen = await client.fetchScreen(summary!.screenId, {}, who);

  return { health, stats: screen.ok ? extractData(screen.value.ui).stats : [] };
}

beforeAll(async () => {
  const app = createApp({ repository: new OrderRepository(seedOrders()), principalSecret: SECRET });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");

  client = new SatelliteClient({
    satellite: SatelliteSchema.parse({
      id: "orders",
      displayName: "Order Management",
      baseUrl: `http://127.0.0.1:${address.port}`,
      owner: "fulfillment-team",
      // Matches what this satellite actually declares. The client refuses a
      // manifest claiming an audience its registry entry does not grant, so a
      // narrower fixture fails every test here with a misleading "down".
      audience: ["internal", "external"],
      rbacScopes: ["orders.read"],
    }),
    principalSecret: SECRET,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("this satellite on the front page", () => {
  it("is reported healthy through the path its own manifest declares", async () => {
    const overview = await overviewOf(principal);

    expect(overview.health.status).toBe("ok");
    expect(overview.health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("shows the figures its nominated screen actually carries", async () => {
    const overview = await overviewOf(principal);

    // The seed has three orders for `acme`, two pending and one blocked. If
    // `orders.list` stops carrying tiles, this is where it is noticed — not by
    // whoever opens the portal.
    expect(overview.stats).toEqual([
      { label: "Total orders", value: "3" },
      { label: "Pending", value: "2" },
      { label: "Blocked", value: "1" },
    ]);
  });

  it("shows this tenant's figures, not the whole table's", async () => {
    const other = await overviewOf({ ...principal, tenantId: "globex" });

    // globex has two orders. The summary screen is fetched with the caller's
    // principal like any other, so the satellite scopes it — the front page is
    // not a way around tenant isolation.
    expect(other.stats[0]).toEqual({ label: "Total orders", value: "2" });
  });

  it("is honest, not blank, when the caller may not read the screen", async () => {
    const overview = await overviewOf({ ...principal, scopes: [] });

    // Health is the hub's question and still answers; the figures are the
    // satellite's and it refused. A card with a green pill and no numbers is
    // the correct rendering of exactly that.
    expect(overview.health.status).toBe("ok");
    expect(overview.stats).toEqual([]);
  });
});
