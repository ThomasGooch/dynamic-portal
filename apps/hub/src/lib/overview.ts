import type { Principal } from "@portal/identity";
import { extractData, type ExtractedStat } from "@portal/mcp-gateway";
import type { Manifest, ScreenResponse } from "@portal/protocol";
import type { HealthReport, Result } from "@portal/registry";

/**
 * What the portal can say about one solution before anybody clicks it.
 *
 * Two halves, from two different owners, and keeping them apart is the whole
 * design:
 *
 * **Health is the hub's.** Whether a satellite answers, how fast, and whether
 * the hub's own traffic to it has been failing — that last one is something no
 * satellite can report about itself. It comes from `healthPath`, which has sat
 * in the manifest and all three SDKs with no consumer until now.
 *
 * **The figures are the satellite's.** Not fetched from a metrics endpoint and
 * not computed here: they are the stat tiles already on a screen the satellite
 * nominated, recovered with the same extractor the agent's read tools use. So
 * the front page cannot say anything a team is not already showing its own
 * users, and there is no second artifact to drift — the same bet the rest of
 * this architecture makes.
 *
 * The consequence worth stating plainly: **nothing in this file knows what an
 * order is.** No satellite id appears, no metric is named, and adding a fourth
 * solution needs no change here. A version of this that special-cased one
 * satellite would have quietly reintroduced the per-solution hub code the
 * portal exists to avoid.
 *
 * **Nothing here is cached, and that is a choice with a cost.** Every visit to
 * the front page asks each satellite for its manifest, its health and its
 * summary screen — three requests per solution, per view. A short-TTL cache is
 * the obvious fix and is deliberately not taken: the manifest is exactly what
 * makes "edit a satellite's screen, refresh, see the change, deploy nothing"
 * true, and caching it would buy load at the price of the property this whole
 * portal is built to demonstrate. The requests are cheap, bounded by each
 * satellite's `timeoutMs`, and independent per card. If this ever needs to
 * scale, cache the *summary screen* — never the manifest.
 */

/** Room for a headline, not a dashboard. A card is read at a glance or not at all. */
export const MAX_SUMMARY_STATS = 4;

/**
 * The parts of a `SatelliteClient` this needs.
 *
 * Narrowed to three methods so a test can supply them directly. The alternative
 * is mocking the portal singleton, which makes every case here a test of the
 * mock.
 */
export interface OverviewSource {
  readonly fetchManifest: () => Promise<Result<Manifest>>;
  readonly checkHealth: (healthPath: string) => Promise<HealthReport>;
  readonly fetchScreen: (
    screenId: string,
    params: Readonly<Record<string, string>>,
    principal: Principal,
  ) => Promise<Result<ScreenResponse>>;
}

export interface SatelliteOverview {
  readonly health: HealthReport;
  readonly stats: readonly ExtractedStat[];
}

const UNREACHABLE: HealthReport = { status: "down", detail: "did not answer" };

export async function satelliteOverview(
  source: OverviewSource,
  principal: Principal,
): Promise<SatelliteOverview> {
  try {
    // The manifest first, because it names both of the things below. A
    // satellite whose manifest will not load has nothing else worth asking.
    const manifest = await source.fetchManifest();
    if (!manifest.ok) return { health: UNREACHABLE, stats: [] };

    const { healthPath, summary } = manifest.value;

    // Concurrently: a slow summary screen must not delay the health pill, which
    // is the part that matters when something is wrong.
    const [health, stats] = await Promise.all([
      healthPath === undefined
        ? // Not a fault. A satellite that declared no health path has told the
          // portal nothing, and "down" would be the portal inventing a problem.
          Promise.resolve<HealthReport>({ status: "unknown" })
        : source.checkHealth(healthPath),
      summary === undefined
        ? Promise.resolve<readonly ExtractedStat[]>([])
        : summaryStats(source, summary.screenId, principal),
    ]);

    return { health, stats };
  } catch {
    // This runs once per card. An exception escaping here would take out the
    // whole page — the blast radius the portal promises it does not have,
    // reintroduced on its own front door.
    return { health: UNREACHABLE, stats: [] };
  }
}

async function summaryStats(
  source: OverviewSource,
  screenId: string,
  principal: Principal,
): Promise<readonly ExtractedStat[]> {
  // No parameters, because the hub has none to give. `ManifestSchema` refuses a
  // summary screen that requires any, so this is a fact rather than a hope.
  const screen = await source.fetchScreen(screenId, {}, principal);
  if (!screen.ok) return [];

  // Stats only. A summary is the figures a team chose to headline, not a scrape
  // of everything on the screen — the tables and charts stay where they are.
  return extractData(screen.value.ui).stats.slice(0, MAX_SUMMARY_STATS);
}
