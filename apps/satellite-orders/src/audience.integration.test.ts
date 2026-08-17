import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signPrincipal, type Principal } from "@portal/identity";
import type { Manifest } from "@portal/protocol";
import { createApp } from "./app";
import { OrderRepository, seedOrders } from "./repository";
import { manifest } from "./screens";

/**
 * Per-resource audience, tested against a satellite that has widened.
 *
 * The protocol lets a screen declare a *narrower* audience than its satellite,
 * and `ManifestSchema` validates subset rather than equality. While both are
 * `["internal"]` a satellite-level check is indistinguishable from a per-screen
 * one, so the interesting case cannot be observed on the real manifest — it
 * only appears once the satellite is exposed externally.
 *
 * With external clients in scope that widening is a matter of when. This suite
 * injects the widened declaration so the property is pinned *before* it
 * matters, rather than discovered by an external principal reading an internal
 * screen.
 */

const SECRET = "audience-secret";

/**
 * Satellite exposed externally; `orders.detail` held internal-only.
 *
 * Both audiences are set *explicitly*. An earlier version set only
 * `orders.list` and let `orders.detail` inherit whatever the real manifest
 * said — which was internal, until the day it was not, and the suite silently
 * stopped testing the case it exists for. A fixture describing a scenario has
 * to state the whole scenario.
 */
function widenedManifest(): Manifest {
  const base = manifest();
  return {
    ...base,
    audience: ["internal", "external"],
    screens: base.screens.map((s) => ({
      ...s,
      audience:
        s.id === "orders.list" ? (["internal", "external"] as const) : (["internal"] as const),
    })),
  };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp({
    repository: new OrderRepository(seedOrders()),
    principalSecret: SECRET,
    manifest: widenedManifest(),
  });
  server = await new Promise<Server>((resolve) => {
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

const principal = (audience: Principal["audience"]): string =>
  signPrincipal(
    {
      sub: "e2e@acme.example",
      tenantId: "acme",
      audience,
      scopes: ["orders.read", "orders.write"],
    },
    SECRET,
  );

const get = (path: string, audience: Principal["audience"]) =>
  fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${principal(audience)}` },
  });

describe("a satellite exposed externally still honours a narrower screen", () => {
  it("serves an externally-declared screen to an external principal", async () => {
    expect((await get("/portal/screens/orders.list", "external")).status).toBe(200);
  });

  it("refuses an internal-only screen to an external principal", async () => {
    // The bug this pins: checking only the satellite audience would serve this,
    // because the satellite is now external-facing.
    expect(
      (await get("/portal/screens/orders.detail?id=ord-1001", "external")).status,
    ).toBe(403);
  });

  it("still serves both to an internal principal", async () => {
    expect((await get("/portal/screens/orders.list", "internal")).status).toBe(200);
    expect(
      (await get("/portal/screens/orders.detail?id=ord-1001", "internal")).status,
    ).toBe(200);
  });

  it("refuses an internal-only action to an external principal", async () => {
    const res = await fetch(`${baseUrl}/portal/actions/orders.approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${principal("external")}`,
      },
      body: JSON.stringify({ id: "ord-1001" }),
    });
    expect(res.status).toBe(403);
  });
});
