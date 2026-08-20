import { describe, expect, it } from "vitest";
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

function source(over: Partial<OverviewSource> = {}): OverviewSource {
  return {
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
          return { status: "degraded", detail: "recent requests failed" };
        },
      }),
      principal,
    );

    expect(asked).toEqual(["/healthz"]);
    expect(overview.health.status).toBe("degraded");
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
