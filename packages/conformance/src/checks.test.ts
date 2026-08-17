import { CURRENT_PROTOCOL_VERSION, type Manifest } from "@portal/protocol";
import { describe, expect, it } from "vitest";
import { runConformance, type CheckResult, type CheckStatus } from "./checks";

const SECRET = "conformance-test-secret";

const manifest = (over: Partial<Manifest> = {}) => ({
  protocol: CURRENT_PROTOCOL_VERSION,
  satelliteId: "orders",
  displayName: "Orders",
  audience: ["internal"],
  screens: [{ id: "orders.list", title: "Orders", audience: ["internal"] }],
  actions: [],
  healthPath: "/healthz",
  ...over,
});

const screen = {
  protocol: CURRENT_PROTOCOL_VERSION,
  screen: { id: "orders.list", title: "Orders" },
  ui: { type: "Page", children: [{ type: "Text", props: { text: "Nothing yet." } }] },
};

interface Route {
  readonly status?: number;
  readonly body?: unknown;
  /** Status when the request carried no authorization header. */
  readonly unauthenticated?: number;
  /** Status when the header was present but not a valid signature. */
  readonly forged?: number;
  /** Status when the principal's audience is `external`. */
  readonly foreign?: number;
}

function decodeClaims(header: string): { audience?: string } | undefined {
  const payload = header.replace("Bearer ", "").split(".")[0] ?? "";
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { audience?: string };
  } catch {
    return undefined;
  }
}

/** A satellite made of a lookup table, so a check can be pointed at any shape. */
function fakeSatellite(routes: Record<string, Route>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const route = routes[url.pathname];
    if (route === undefined) return new Response("nope", { status: 404 });

    const auth = (init?.headers as Record<string, string> | undefined)?.["authorization"];

    if (auth === undefined) {
      return route.unauthenticated === undefined
        ? new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 })
        : new Response("{}", { status: route.unauthenticated });
    }

    // Decoded rather than pattern-matched, because that is what a satellite
    // does: `not.a.real.token` has the right *shape* and its payload is not
    // JSON. An earlier version of this fake tested for a dot and fell through
    // to a decode that threw — the probe reported a failure and the fake was
    // the thing that was broken.
    const claims = decodeClaims(auth);
    if (claims === undefined) {
      // Falls through to serving the body when `forged` is unset, because that
      // is what a lax satellite does — omitting the field is how a test says
      // "this one accepts anything".
      if (route.forged !== undefined) return new Response("{}", { status: route.forged });
      return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
    }
    if (claims.audience === "external" && route.foreign !== undefined) {
      return new Response("{}", { status: route.foreign });
    }

    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  }) as typeof fetch;
}

const healthy = (over: Record<string, Route> = {}) =>
  fakeSatellite({
    "/portal/manifest": { body: manifest() },
    "/portal/screens/orders.list": {
      body: screen,
      unauthenticated: 401,
      forged: 401,
      foreign: 403,
    },
    "/healthz": { body: { status: "ok" } },
    ...over,
  });

const run = (fetchImpl: typeof fetch) =>
  runConformance({ baseUrl: "http://satellite.test", principalSecret: SECRET, fetch: fetchImpl });

const statusOf = (results: readonly CheckResult[], name: string): CheckStatus | undefined =>
  results.find((result) => result.name.startsWith(name))?.status;

describe("a satellite that behaves", () => {
  it("passes", async () => {
    const report = await run(healthy());
    expect(report.ok).toBe(true);
    expect(statusOf(report.results, "manifest")).toBe("pass");
    expect(statusOf(report.results, "screen orders.list")).toBe("pass");
    expect(statusOf(report.results, "health")).toBe("pass");
  });

  it("still reports what it could not check", async () => {
    // The property that makes a green run trustworthy. Tenant isolation needs
    // two tenants' records and both sets of credentials; claiming it as a pass
    // would be the most dangerous thing this tool could do.
    const report = await run(healthy());
    expect(statusOf(report.results, "tenant isolation")).toBe("skip");
  });
});

describe("the claims a manifest cannot make", () => {
  it("fails a satellite that serves an unsigned request", async () => {
    const report = await run(
      healthy({
        "/portal/screens/orders.list": { body: screen, forged: 401, foreign: 403 },
      }),
    );
    expect(statusOf(report.results, "refuses an unsigned request")).toBe("fail");
    expect(report.ok).toBe(false);
  });

  it("fails a satellite that accepts a forged signature", async () => {
    const report = await run(
      healthy({
        "/portal/screens/orders.list": { body: screen, unauthenticated: 401, foreign: 403 },
      }),
    );
    expect(statusOf(report.results, "refuses a forged signature")).toBe("fail");
  });

  it("fails a satellite that serves an audience it never declared", async () => {
    // The one that turns a hub bug into a disclosure if it is wrong.
    const report = await run(
      healthy({
        "/portal/screens/orders.list": { body: screen, unauthenticated: 401, forged: 401 },
      }),
    );
    expect(statusOf(report.results, "refuses an undeclared audience")).toBe("fail");
  });
});

describe("screens", () => {
  it("fails a screen the hub could not draw", async () => {
    const report = await run(
      healthy({
        "/portal/screens/orders.list": {
          body: {
            ...screen,
            ui: { type: "Page", children: [{ type: "Script", props: {} }] },
          },
          unauthenticated: 401,
          forged: 401,
          foreign: 403,
        },
      }),
    );
    expect(statusOf(report.results, "screen orders.list")).toBe("fail");
  });

  it("does not blame a satellite for refusing scopes the probe was not given", async () => {
    // Required scopes live in the hub's registry, not the manifest, so this
    // tool cannot discover them. A failure here would report correct behaviour
    // as a defect.
    const report = await run(
      healthy({
        "/portal/screens/orders.list": {
          status: 403,
          unauthenticated: 401,
          forged: 401,
        },
      }),
    );
    expect(statusOf(report.results, "screen orders.list")).toBe("skip");
    expect(report.ok).toBe(true);
  });

  it("skips a screen behind a required parameter rather than inventing one", async () => {
    const report = await run(
      healthy({
        "/portal/manifest": {
          body: manifest({
            screens: [
              {
                id: "orders.detail",
                title: "Detail",
                params: [{ name: "id", required: true }],
                audience: ["internal"],
              },
            ],
          }),
        },
        "/portal/screens/orders.detail": {
          body: screen,
          unauthenticated: 401,
          forged: 401,
          foreign: 403,
        },
      }),
    );
    expect(statusOf(report.results, "screen orders.detail")).toBe("skip");
  });
});

describe("actions", () => {
  it("warns about an action no agent can call", async () => {
    // A warning rather than a failure: the satellite is fine for the screens,
    // and the cost is a capability the agent silently does not have.
    const report = await run(
      healthy({
        "/portal/manifest": {
          body: manifest({ actions: [{ id: "orders.approve", audience: ["internal"] }] }),
        },
      }),
    );
    expect(statusOf(report.results, "action orders.approve")).toBe("warn");
    expect(report.ok).toBe(true);
  });

  it("passes an action that declares its parameters", async () => {
    const report = await run(
      healthy({
        "/portal/manifest": {
          body: manifest({
            actions: [
              {
                id: "orders.approve",
                params: [{ name: "id", type: "string", required: true }],
                audience: ["internal"],
              },
            ],
          }),
        },
      }),
    );
    expect(statusOf(report.results, "action orders.approve")).toBe("pass");
  });
});

describe("a service that is not a satellite", () => {
  it("says so once, rather than failing twenty checks that all depend on it", async () => {
    const report = await run(fakeSatellite({}));
    expect(report.ok).toBe(false);
    expect(report.results.filter((result) => result.status === "fail")).toHaveLength(1);
    expect(statusOf(report.results, "everything else")).toBe("skip");
  });

  it("fails a manifest that does not match the protocol", async () => {
    const report = await run(
      fakeSatellite({ "/portal/manifest": { body: { protocol: "1.0" } } }),
    );
    expect(statusOf(report.results, "manifest")).toBe("fail");
  });

  it("fails a satellite on a protocol version the hub has dropped", async () => {
    const report = await run(
      healthy({ "/portal/manifest": { body: manifest({ protocol: "99.0" }) } }),
    );
    expect(statusOf(report.results, "protocol version")).toBe("fail");
  });
});
