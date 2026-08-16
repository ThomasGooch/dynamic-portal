import { describe, expect, it, vi } from "vitest";
import { CURRENT_PROTOCOL_VERSION } from "@portal/protocol";
import type { Principal } from "@portal/identity";
import { CircuitBreaker } from "./breaker.js";
import { SatelliteClient } from "./client.js";
import { loadRegistry } from "./registry.js";

const satellite = loadRegistry(
  "- id: orders\n  displayName: Orders\n  baseUrl: http://sat.test\n  owner: t\n  timeoutMs: 50\n",
)[0]!;

const principal: Principal = {
  sub: "alice@acme.example",
  tenantId: "acme",
  audience: "internal",
  scopes: ["orders.read"],
};

const goodScreen = {
  protocol: CURRENT_PROTOCOL_VERSION,
  screen: { id: "orders.list", title: "Orders" },
  ui: { type: "Page", children: [{ type: "Heading", props: { text: "Orders" } }] },
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function client(fetchImpl: typeof fetch, breaker?: CircuitBreaker) {
  return new SatelliteClient({
    satellite,
    principalSecret: "s",
    fetch: fetchImpl,
    ...(breaker ? { breaker } : {}),
  });
}

describe("fetching a screen", () => {
  it("returns the screen when the satellite answers correctly", async () => {
    const result = await client(async () => respond(goodScreen)).fetchScreen(
      "orders.list",
      {},
      principal,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.screen.id).toBe("orders.list");
  });

  it("forwards a signed principal rather than the caller's raw credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => respond(goodScreen));
    await client(fetchImpl).fetchScreen("orders.list", {}, principal);
    const init = fetchImpl.mock.calls[0]?.[1];
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    expect(auth).toMatch(/^Bearer \S+\.\S+$/);
    // The satellite verifies this itself; the hub does not get to assert an
    // identity, it has to present one that survives verification.
    expect(auth).not.toContain(principal.sub);
  });

  it("passes query parameters through", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => respond(goodScreen));
    await client(fetchImpl).fetchScreen("orders.detail", { id: "ord-1" }, principal);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("id=ord-1");
  });
});

describe("a satellite behaving badly", () => {
  it("rejects a response that is not valid PUP rather than passing it on", async () => {
    // The proxy is the trust boundary. Forwarding a malformed screen would move
    // the failure into the browser, where it renders as a broken page rather
    // than a diagnosable error.
    const result = await client(async () => respond({ nope: true })).fetchScreen(
      "orders.list",
      {},
      principal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-response");
  });

  it("rejects a screen containing a component outside the catalog", async () => {
    const result = await client(async () =>
      respond({ ...goodScreen, ui: { type: "Page", children: [{ type: "Script" }] } }),
    ).fetchScreen("orders.list", {}, principal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-response");
  });

  it("rejects a screen carrying a styling escape hatch", async () => {
    const result = await client(async () =>
      respond({
        ...goodScreen,
        ui: { type: "Page", props: { className: "danger" } },
      }),
    ).fetchScreen("orders.list", {}, principal);
    expect(result.ok).toBe(false);
  });

  it("never leaks an upstream error body to the caller", async () => {
    const result = await client(async () =>
      new Response("Traceback: /srv/app/secret.py line 42", { status: 500 }),
    ).fetchScreen("orders.list", {}, principal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result)).not.toContain("secret.py");
  });

  it("times out rather than waiting on a hung satellite", async () => {
    const result = await client(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }) as Promise<Response>,
    ).fetchScreen("orders.list", {}, principal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("timeout");
  });
});

describe("the circuit breaker", () => {
  it("counts a server error as a failure", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, now: () => 0 });
    await client(async () => respond({}, 500), breaker).fetchScreen("orders.list", {}, principal);
    expect(breaker.state).toBe("open");
  });

  it("counts an invalid response as a failure — garbage is a fault, not an answer", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, now: () => 0 });
    await client(async () => respond({ nope: true }), breaker).fetchScreen(
      "orders.list",
      {},
      principal,
    );
    expect(breaker.state).toBe("open");
  });

  it("does NOT count a 404 as a failure", async () => {
    // A satellite answering "no such order" is working correctly. Tripping the
    // breaker on it would take a healthy satellite offline because a user
    // followed a stale link.
    const breaker = new CircuitBreaker({ failureThreshold: 1, now: () => 0 });
    const result = await client(async () => respond({}, 404), breaker).fetchScreen(
      "orders.detail",
      {},
      principal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-found");
    expect(breaker.state).toBe("closed");
  });

  it("does NOT count a 403 as a failure either", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, now: () => 0 });
    await client(async () => respond({}, 403), breaker).fetchScreen("orders.list", {}, principal);
    expect(breaker.state).toBe("closed");
  });

  it("refuses without calling the satellite once open, and says how long to wait", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 5000, now: () => 0 });
    breaker.recordFailure();
    const fetchImpl = vi.fn<typeof fetch>(async () => respond(goodScreen));
    const result = await client(fetchImpl, breaker).fetchScreen("orders.list", {}, principal);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    // Narrowed on `reason`, not asserted through: `retryAfterMs` exists only on
    // the unavailable branch, and the compiler should be the one saying so.
    if (!result.ok && result.reason === "unavailable") {
      expect(result.retryAfterMs).toBe(5000);
    } else {
      throw new Error(`expected unavailable, got ${result.ok ? "ok" : result.reason}`);
    }
  });

  it("closes again after a success", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, now: () => 0 });
    breaker.recordFailure();
    await client(async () => respond(goodScreen), breaker).fetchScreen(
      "orders.list",
      {},
      principal,
    );
    expect(breaker.state).toBe("closed");
  });
});

describe("invoking an action", () => {
  it("returns a valid ActionResponse", async () => {
    const body = {
      protocol: CURRENT_PROTOCOL_VERSION,
      outcome: "ok",
      toast: { level: "success", message: "Approved" },
    };
    const result = await client(async () => respond(body)).invokeAction(
      "orders.approve",
      { id: "ord-1" },
      principal,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.outcome).toBe("ok");
  });

  it("rejects an incoherent ActionResponse", async () => {
    // outcome "ok" carrying field errors is exactly what the protocol's
    // coherence rules exist to stop; the proxy must not forward it.
    const result = await client(async () =>
      respond({
        protocol: CURRENT_PROTOCOL_VERSION,
        outcome: "ok",
        fieldErrors: { id: "nope" },
      }),
    ).invokeAction("orders.approve", {}, principal);
    expect(result.ok).toBe(false);
  });

  it("validates the ui inside a patch, not just the envelope", async () => {
    const result = await client(async () =>
      respond({
        protocol: CURRENT_PROTOCOL_VERSION,
        outcome: "ok",
        patch: [{ targetId: "t", ui: { type: "NotAComponent" } }],
      }),
    ).invokeAction("orders.approve", {}, principal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-response");
  });
});
