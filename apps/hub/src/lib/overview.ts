import { authorize, type Principal } from "@portal/identity";
import { extractData, type ExtractedStat } from "@portal/mcp-gateway";
import type { Manifest, ScreenResponse } from "@portal/protocol";
import type { Failure, HealthReport, Result } from "@portal/registry";

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
 * portal is built to demonstrate. The requests are cheap and independent per
 * card. A card is bounded by *twice* each satellite's `timeoutMs`, not once:
 * the manifest is awaited before health and the summary screen are started, so
 * a satellite that answers its manifest slowly and then stalls costs both
 * budgets. Worth knowing before anyone reads `timeoutMs` as the page's
 * deadline. If this ever needs to scale, cache the *summary screen* — never the
 * manifest.
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
  /**
   * Records the summary read, exactly as every other read of this data is
   * recorded.
   *
   * This was missing, and it was the only projection over tenant-scoped figures
   * that had no entry in the log: the screen route awaits `recordAudit`, the
   * agent's tools record through `onAudit`, the public façade records — and a
   * single visit to the front page performed three unrecorded reads of real
   * order counts for a real tenant. On a system whose case rests on being able
   * to answer "which records were read, for whom, when", a page that reads and
   * says nothing is the gap that matters.
   *
   * Awaited, and allowed to reject. `lib/audit.ts` fails closed on purpose: a
   * read that cannot be recorded does not count as having happened, and the
   * figures are dropped rather than shown.
   */
  readonly recordRead: (input: {
    readonly screenId: string;
    readonly outcome: "ok" | "error";
    readonly reason?: string;
    readonly latencyMs: number;
  }) => Promise<void>;
}

export interface SatelliteOverview {
  readonly health: HealthReport;
  readonly stats: readonly ExtractedStat[];
  /**
   * Set when figures were read and then deliberately not shown.
   *
   * Only one thing causes it today — the audit write failed — and the card says
   * so rather than rendering an empty space. A blank card is indistinguishable
   * from a satellite that nominates no summary screen, and those two mean
   * opposite things to whoever is looking.
   */
  readonly figuresWithheld?: string;
}

const UNREACHABLE: HealthReport = { status: "down", detail: "did not answer" };

/**
 * Why the manifest could not be read, in the card's words.
 *
 * Every branch is `down` — with no manifest there is no `healthPath` to probe
 * and the portal genuinely does not know — but the reason is not the same
 * reason, and a card that says "did not answer" about a satellite that answered
 * sends whoever is on call to look at the wrong thing.
 *
 * `unavailable` is the breaker refusing the hub's own request: the satellite
 * was never contacted, so "did not answer" would be the portal reporting a
 * silence it never listened for. The rest split on whether anything came back
 * at all — a 404, a 403 or a malformed body is a live process serving the wrong
 * thing, which is a deploy to look at rather than a host.
 *
 * No `detail` from the failure crosses into the returned report. A satellite
 * controls the text of an `invalid-response` detail, and this string is
 * rendered on the front page for every account that can see the solution.
 */
function unreachable(failure: Failure): HealthReport {
  switch (failure.reason) {
    case "unavailable":
      return { status: "down", detail: "not contacted: recent requests to this solution failed" };
    case "timeout":
      return UNREACHABLE;
    case "upstream-error":
      return { status: "down", detail: `answered ${failure.status} for its manifest` };
    case "not-found":
    case "forbidden":
      return { status: "down", detail: "answered, but would not serve its manifest" };
    case "invalid-response":
      return { status: "down", detail: "answered with something that is not a manifest" };
    default:
      // A reason added to `Failure` and not given a branch here. Saying only
      // what is certainly true beats inheriting whichever neighbour it was
      // written next to — "did not answer" would be a claim nobody checked.
      return { status: "down", detail: "its manifest could not be read" };
  }
}

export async function satelliteOverview(
  source: OverviewSource,
  principal: Principal,
): Promise<SatelliteOverview> {
  try {
    // The manifest first, because it names both of the things below. A
    // satellite whose manifest will not load has nothing else worth asking.
    const manifest = await source.fetchManifest();
    if (!manifest.ok) return { health: unreachable(manifest), stats: [] };

    const { healthPath, summary } = manifest.value;

    // The screen route filters a satellite's screens by the audience each one
    // declares before it will fetch any of them, and this is the same read of
    // the same data by the same hub — so it answers to the same rule. A
    // satellite whose summary screen is `["internal"]` must not have its tiles
    // fetched for an external principal just because they arrived by the front
    // page. The satellite refuses too, but "the other side also checks" is the
    // argument for leaving out every check the hub makes.
    const nominated =
      summary === undefined
        ? undefined
        : manifest.value.screens.find((screen) => screen.id === summary.screenId);
    const readable =
      nominated !== undefined &&
      authorize(principal, { audience: nominated.audience, rbacScopes: [] }).allowed;

    // Concurrently: a slow summary screen must not delay the health pill, which
    // is the part that matters when something is wrong.
    const [health, figures] = await Promise.all([
      healthPath === undefined
        ? // Not a fault. A satellite that declared no health path has told the
          // portal nothing, and "down" would be the portal inventing a problem.
          Promise.resolve<HealthReport>({ status: "unknown" })
        : source.checkHealth(healthPath),
      summary === undefined || !readable
        ? Promise.resolve<Figures>({ stats: [] })
        : summaryStats(source, summary.screenId, principal),
    ]);

    return {
      health,
      stats: figures.stats,
      ...(figures.withheld === undefined ? {} : { figuresWithheld: figures.withheld }),
    };
  } catch {
    // This runs once per card. An exception escaping here would take out the
    // whole page — the blast radius the portal promises it does not have,
    // reintroduced on its own front door.
    return { health: UNREACHABLE, stats: [] };
  }
}

interface Figures {
  readonly stats: readonly ExtractedStat[];
  readonly withheld?: string;
}

async function summaryStats(
  source: OverviewSource,
  screenId: string,
  principal: Principal,
): Promise<Figures> {
  // Contained here rather than left to the caller's catch. The figures are the
  // lesser half of the card: a satellite that answered its health probe must
  // still read `ok`, and letting a throw from here — `fetchScreen`, or
  // `extractData` walking a tree the satellite controls — reject the
  // `Promise.all` above would discard that measured health and report a
  // demonstrably live solution as down.
  const startedAt = Date.now();
  let screen: Result<ScreenResponse>;
  try {
    // No parameters, because the hub has none to give. `ManifestSchema` refuses
    // a summary screen that requires any, so this is a fact rather than a hope.
    screen = await source.fetchScreen(screenId, {}, principal);
  } catch {
    // Recorded as an error before returning, for the same reason the failures
    // are recorded everywhere else: a log that holds only the reads that worked
    // cannot answer what was attempted.
    await record(source, screenId, "error", "unreachable", startedAt);
    return { stats: [] };
  }

  const recorded = await record(
    source,
    screenId,
    screen.ok ? "ok" : "error",
    screen.ok ? undefined : screen.reason,
    startedAt,
  );

  if (!screen.ok) return { stats: [] };

  // The read happened and could not be recorded. `lib/audit.ts` fails closed on
  // purpose, and the screen route says it plainly: a read that cannot be
  // recorded does not count as having happened. The figures are dropped rather
  // than rendered — the page stays up, this card simply says nothing it cannot
  // account for.
  if (!recorded) {
    return { stats: [], withheld: "figures withheld: this read could not be recorded" };
  }

  try {
    // Stats only. A summary is the figures a team chose to headline, not a
    // scrape of everything on the screen — tables and charts stay where they are.
    return { stats: extractData(screen.value.ui).stats.slice(0, MAX_SUMMARY_STATS) };
  } catch {
    return { stats: [] };
  }
}

/** True when the read was recorded. Never throws: the caller decides. */
async function record(
  source: OverviewSource,
  screenId: string,
  outcome: "ok" | "error",
  reason: string | undefined,
  startedAt: number,
): Promise<boolean> {
  try {
    await source.recordRead({
      screenId,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      latencyMs: Math.max(Date.now() - startedAt, 0),
    });
    return true;
  } catch {
    return false;
  }
}
