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

  it("rejects a screen on a protocol major outside the support window", async () => {
    // The schema only checks that "9.0" is well-formed. Parsed against today's
    // schemas it would render as if it were current, silently.
    const result = await client(async () => respond({ ...goodScreen, protocol: "9.0" })).fetchScreen(
      "orders.list",
      {},
      principal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-response");
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

  it("times out on a satellite that answers 200 and then stalls mid-body", async () => {
    // The deadline has to cover reading the body. Clearing it once the headers
    // arrive lets a satellite hold the hub's request open indefinitely — the
    // exact hang `timeoutMs` is there to prevent, reached by a slightly more
    // patient route.
    const fetchImpl: typeof fetch = async (_input, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"pro'));
          signal?.addEventListener("abort", () =>
            controller.error(new DOMException("aborted", "AbortError")),
          );
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await client(fetchImpl).fetchScreen("orders.list", {}, principal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("timeout");
  });
});

describe("fetching a manifest", () => {
  const manifest = {
    protocol: CURRENT_PROTOCOL_VERSION,
    satelliteId: "orders",
    displayName: "Orders",
    audience: ["internal"],
    screens: [{ id: "orders.list", title: "Orders", audience: ["internal"] }],
    actions: [],
  };

  it("accepts a manifest that agrees with the registry", async () => {
    const result = await client(async () => respond(manifest)).fetchManifest();
    expect(result.ok).toBe(true);
  });

  it("rejects a manifest claiming another satellite's id", async () => {
    // The manifest is the satellite's self-declaration; the registry is the
    // file that was reviewed. Accepting the claim would attribute one team's
    // screens to another.
    const result = await client(async () =>
      respond({ ...manifest, satelliteId: "fleet" }),
    ).fetchManifest();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-response");
  });

  it("rejects a manifest widening its own audience past the registry's", async () => {
    // The registry says internal-only. A projection filtering on the manifest's
    // audience would otherwise publish these screens outside the org.
    const result = await client(async () =>
      respond({
        ...manifest,
        audience: ["internal", "external"],
      }),
    ).fetchManifest();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-response");
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

  it("does NOT count a 422 as a failure — a rejected query is still an answer", async () => {
    // FastAPI answers 422 for a malformed query parameter. Five stale links
    // would otherwise take a demonstrably healthy satellite offline for
    // everyone, which is what the 4xx carve-out exists to prevent.
    const breaker = new CircuitBreaker({ failureThreshold: 1, now: () => 0 });
    const result = await client(async () => respond({}, 422), breaker).fetchScreen(
      "orders.detail",
      {},
      principal,
    );
    expect(result.ok).toBe(false);
    expect(breaker.state).toBe("closed");
  });

  it("closes the circuit on a 4xx: the satellite demonstrably answered", async () => {
    // Recording no outcome at all would leave the half-open probe outstanding,
    // so a recovered satellite whose next request happens to 404 would be
    // refused for a further cooldown — and again, once per cooldown, forever.
    let clock = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => clock });
    breaker.recordFailure();
    expect(breaker.state).toBe("open");

    clock = 100;
    await client(async () => respond({}, 404), breaker).fetchScreen("orders.detail", {}, principal);
    expect(breaker.state).toBe("closed");

    const fetchImpl = vi.fn<typeof fetch>(async () => respond(goodScreen));
    const result = await client(fetchImpl, breaker).fetchScreen("orders.list", {}, principal);
    expect(fetchImpl).toHaveBeenCalled();
    expect(result.ok).toBe(true);
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
