import { beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "@portal/identity";
import { CURRENT_PROTOCOL_VERSION, type Manifest } from "@portal/protocol";
import type { HealthReport, Result } from "@portal/registry";
import { MAX_SUMMARY_STATS, satelliteOverview, type OverviewSource } from "./overview";

/**
 * What the front page can say about a solution before anyone clicks.
 *
 * The rule every test here is really defending: **the hub must not know what
 * an order is.** The figures on a card are whichever stat tiles the satellite
 * already puts on a screen it nominated, recovered by the same extractor the
 * agent's read tools use. Nothing here maps a satellite id to a metric, and
 * nothing here should ever need to.
 */

const principal: Principal = {
  sub: "dev@acme.example",
  tenantId: "acme",
  audience: "internal",
  scopes: ["orders.read"],
};

const manifest = (over: Partial<Manifest> = {}): Manifest =>
  ({
    protocol: CURRENT_PROTOCOL_VERSION,
    satelliteId: "orders",
    displayName: "Order Management",
    audience: ["internal"],
    screens: [{ id: "orders.list", title: "Orders", audience: ["internal"] }],
    actions: [],
    healthPath: "/healthz",
    summary: { screenId: "orders.list" },
    ...over,
  }) as Manifest;

const screenWith = (children: unknown[]) => ({
  protocol: CURRENT_PROTOCOL_VERSION,
  screen: { id: "orders.list", title: "Orders" },
  ui: { type: "Page", children },
});

const tile = (label: string, value: string) => ({ type: "StatTile", props: { label, value } });

/** Every read this file makes, so a test can assert what was recorded. */
let recorded: { screenId: string; outcome: string; reason?: string }[] = [];

beforeEach(() => {
  recorded = [];
});

function source(over: Partial<OverviewSource> = {}): OverviewSource {
  return {
    recordRead: async ({ screenId, outcome, reason }) => {
      recorded.push({ screenId, outcome, ...(reason === undefined ? {} : { reason }) });
    },
    fetchManifest: async () => ({ ok: true, value: manifest() }) as Result<Manifest>,
    checkHealth: async () => ({ status: "ok", latencyMs: 4 }) as HealthReport,
    fetchScreen: async () =>
      ({
        ok: true,
        value: screenWith([tile("Total orders", "3"), tile("Pending", "2")]),
      }) as unknown as Result<never>,
    ...over,
  };
}

describe("a solution's card", () => {
  it("shows the stat tiles from the screen the satellite nominated", async () => {
    const overview = await satelliteOverview(source(), principal);

    expect(overview.stats).toEqual([
      { label: "Total orders", value: "3" },
      { label: "Pending", value: "2" },
    ]);
  });

  it("asks for the nominated screen, with no parameters", async () => {
    const asked: string[] = [];
    await satelliteOverview(
      source({
        fetchScreen: async (screenId) => {
          asked.push(screenId);
          return { ok: true, value: screenWith([]) } as unknown as Result<never>;
        },
      }),
      principal,
    );

    // The protocol refuses a summary screen with required params precisely so
    // the hub never has to invent one.
    expect(asked).toEqual(["orders.list"]);
  });

  it("reports health from the path the manifest declared", async () => {
    const asked: string[] = [];
    const overview = await satelliteOverview(
      source({
        checkHealth: async (path) => {
          asked.push(path);
          return { status: "down", detail: "answered 503" };
        },
      }),
      principal,
    );

    expect(asked).toEqual(["/healthz"]);
    expect(overview.health.status).toBe("down");
  });
});

describe("a satellite that declares less", () => {
  it("is unknown, not down, when it declares no health path", async () => {
    const overview = await satelliteOverview(
      source({ fetchManifest: async () => ({ ok: true, value: manifest({ healthPath: undefined }) }) }),
      principal,
    );

    // Nothing is wrong with it. "Down" would be the portal reporting a fault
    // where there is only a satellite that did not opt in.
    expect(overview.health.status).toBe("unknown");
  });

  it("shows no figures, and stays on the page, when it nominates no screen", async () => {
    const overview = await satelliteOverview(
      source({ fetchManifest: async () => ({ ok: true, value: manifest({ summary: undefined }) }) }),
      principal,
    );

    expect(overview.stats).toEqual([]);
    expect(overview.health.status).toBe("ok");
  });

  it("does not fetch a screen it was never pointed at", async () => {
    let fetched = false;
    await satelliteOverview(
      source({
        fetchManifest: async () => ({ ok: true, value: manifest({ summary: undefined }) }),
        fetchScreen: async () => {
          fetched = true;
          return { ok: true, value: screenWith([]) } as unknown as Result<never>;
        },
      }),
      principal,
    );

    expect(fetched).toBe(false);
  });
});

describe("a summary screen this principal may not see", () => {
  const internalOnly = manifest({
    screens: [{ id: "orders.internal", title: "Internal", audience: ["internal"] }],
    summary: { screenId: "orders.internal" },
  });

  it("is not fetched, and shows no figures", async () => {
    let fetched = false;
    const overview = await satelliteOverview(
      source({
        fetchManifest: async () => ({ ok: true, value: internalOnly }),
        fetchScreen: async () => {
          fetched = true;
          return {
            ok: true,
            value: screenWith([tile("Total orders", "3")]),
          } as unknown as Result<never>;
        },
      }),
      { ...principal, audience: "external" },
    );

    // The screen route filters a satellite's screens by their declared audience
    // before it will fetch one. This is the same hub reading the same data, so
    // it answers to the same rule — a screen an external principal would be
    // 404'd for must not arrive on their card because they came in the front
    // door instead. The satellite refuses too; that is not a reason for the hub
    // not to ask the question.
    expect(fetched).toBe(false);
    expect(overview.stats).toEqual([]);
    // Health is the hub's own question and is unaffected by any of this.
    expect(overview.health.status).toBe("ok");
  });

  it("is fetched for a principal whose audience the screen declares", async () => {
    const overview = await satelliteOverview(
      source({ fetchManifest: async () => ({ ok: true, value: internalOnly }) }),
      principal,
    );

    expect(overview.stats).toHaveLength(2);
  });
});

describe("when something is wrong", () => {
  it("reports down and skips the screen when the manifest cannot be read", async () => {
    let fetched = false;
    const overview = await satelliteOverview(
      source({
        fetchManifest: async () => ({ ok: false, reason: "timeout" }) as Result<Manifest>,
        fetchScreen: async () => {
          fetched = true;
          return { ok: true, value: screenWith([]) } as unknown as Result<never>;
        },
      }),
      principal,
    );

    expect(overview.health.status).toBe("down");
    // Without the manifest there is no declared summary screen, so asking for
    // one would mean the hub guessing a screen id — the exact per-satellite
    // knowledge this design keeps out.
    expect(fetched).toBe(false);
    expect(overview.stats).toEqual([]);
  });

  it("keeps the health it measured when only the summary screen fails", async () => {
    const overview = await satelliteOverview(
      source({ fetchScreen: async () => ({ ok: false, reason: "forbidden" }) as Result<never> }),
      principal,
    );

    // A card with a green pill and no figures is honest and still useful. One
    // failing screen must not cost the solution its place on the page.
    expect(overview.health.status).toBe("ok");
    expect(overview.stats).toEqual([]);
  });

  it("does not claim silence from a satellite it never contacted", async () => {
    const overview = await satelliteOverview(
      source({
        fetchManifest: async () =>
          ({ ok: false, reason: "unavailable", retryAfterMs: 20_000 }) as Result<Manifest>,
      }),
      principal,
    );

    // The breaker refused the hub's own request, so nothing was asked and
    // nothing failed to answer. Still down — with no manifest there is no
    // health path to probe — but the card must say which of the two it is.
    expect(overview.health.status).toBe("down");
    expect(overview.health.detail).toMatch(/recent requests/);
  });

  it("does not say a satellite was silent when it answered badly", async () => {
    const overview = await satelliteOverview(
      source({
        fetchManifest: async () =>
          ({ ok: false, reason: "upstream-error", status: 500 }) as Result<Manifest>,
      }),
      principal,
    );

    // Still down — with no manifest there is no health path to probe — but a
    // process that answered 500 is a deploy to look at, and "did not answer"
    // sends whoever is on call to the host instead.
    expect(overview.health.status).toBe("down");
    expect(overview.health.detail).toMatch(/answered 500/);
  });

  it("does not put a satellite's own words on the card", async () => {
    const overview = await satelliteOverview(
      source({
        fetchManifest: async () =>
          ({
            ok: false,
            reason: "invalid-response",
            detail: "screens.0.type: <script>alert(1)</script>",
          }) as Result<Manifest>,
      }),
      principal,
    );

    // The detail on an `invalid-response` quotes strings the satellite chose,
    // and this one is rendered on the front page for every account that can see
    // the solution. The card says what happened in the hub's words.
    expect(overview.health.detail).not.toMatch(/script/);
    expect(overview.health.detail).toMatch(/not a manifest/);
  });

  it("keeps the health it measured when reading the figures throws", async () => {
    const overview = await satelliteOverview(
      source({
        fetchScreen: async () => {
          throw new Error("boom");
        },
      }),
      principal,
    );

    // The figures are the lesser half. A satellite that answered its health
    // probe is up, whatever its summary screen did on the way back.
    expect(overview.health.status).toBe("ok");
    expect(overview.stats).toEqual([]);
  });

  it("never throws, whatever the client does", async () => {
    const overview = await satelliteOverview(
      source({
        fetchManifest: async () => {
          throw new Error("boom");
        },
      }),
      principal,
    );

    // This runs per card. An exception here would take out the whole page,
    // which is precisely the blast radius the portal promises it does not have.
    expect(overview.health.status).toBe("down");
  });
});

describe("what a satellite may put on the page", () => {
  it("caps the figures, so one solution cannot crowd out the others", async () => {
    const many = Array.from({ length: 12 }, (_, index) => tile(`Metric ${index}`, String(index)));
    const overview = await satelliteOverview(
      source({ fetchScreen: async () => ({ ok: true, value: screenWith(many) }) as unknown as Result<never> }),
      principal,
    );

    expect(overview.stats).toHaveLength(MAX_SUMMARY_STATS);
    expect(overview.stats[0]?.label).toBe("Metric 0");
  });

  it("takes only stat tiles, not every number on the screen", async () => {
    const overview = await satelliteOverview(
      source({
        fetchScreen: async () =>
          ({
            ok: true,
            value: screenWith([
              tile("Pending", "2"),
              {
                type: "Table",
                props: {
                  columns: [{ key: "id", label: "Id" }],
                  rows: [{ id: "ord-1" }, { id: "ord-2" }],
                },
              },
            ]),
          }) as unknown as Result<never>,
      }),
      principal,
    );

    // A summary is the figures a team chose to headline, not a scrape of the
    // whole screen. The table is a screen's content; the tile is its summary.
    expect(overview.stats).toEqual([{ label: "Pending", value: "2" }]);
  });
});

describe("the audit record", () => {
  it("records the summary read, like every other read of this data", async () => {
    await satelliteOverview(source(), principal);

    // The screen route, the agent's tools and the public façade all record.
    // This was the fourth projection over the same tenant-scoped figures and
    // the only one that did not, so a visit to the front page read three real
    // order counts and left nothing to answer "who read what, when" with.
    expect(recorded).toEqual([{ screenId: "orders.list", outcome: "ok" }]);
  });

  it("records a refused read too, not only the ones that worked", async () => {
    await satelliteOverview(
      source({ fetchScreen: async () => ({ ok: false, reason: "forbidden" }) as Result<never> }),
      principal,
    );

    expect(recorded).toEqual([
      { screenId: "orders.list", outcome: "error", reason: "forbidden" },
    ]);
  });

  it("withholds the figures when the read cannot be recorded", async () => {
    const overview = await satelliteOverview(
      source({
        recordRead: async () => {
          throw new Error("audit log is not writable");
        },
      }),
      principal,
    );

    // `lib/audit.ts` fails closed and the screen route says why: a read that
    // cannot be recorded does not count as having happened. So the figures are
    // dropped — and the card says so, because an empty space would read as a
    // satellite that nominates no summary screen, which means the opposite.
    expect(overview.stats).toEqual([]);
    expect(overview.figuresWithheld).toMatch(/could not be recorded/);
    // The page stays up: one card going quiet is not the front door failing.
    expect(overview.health.status).toBe("ok");
  });

  it("records nothing when there was nothing to read", async () => {
    await satelliteOverview(
      source({ fetchManifest: async () => ({ ok: true, value: manifest({ summary: undefined }) }) }),
      principal,
    );

    expect(recorded).toEqual([]);
  });
});
