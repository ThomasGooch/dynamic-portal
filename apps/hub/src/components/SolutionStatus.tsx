import { screenRead, type Principal } from "@portal/identity";
import type { Satellite } from "@portal/registry";
import { auditKeyFor, auditStamp, recordAudit } from "@/lib/audit";
import { satelliteOverview } from "@/lib/overview";
import { getPortal } from "@/lib/portal";

/**
 * The live half of a solution's card: is it up, and what does today look like.
 *
 * A server component of its own, rendered inside a `<Suspense>` boundary per
 * card, which is the point. The card's name, description and link come from the
 * registry and need no I/O, so they are on screen immediately; this fills in
 * beside them. One satellite being slow delays its own card and nothing else —
 * the same blast-radius property the screens have, applied to the front page,
 * which is the one page where losing it would be most visible.
 */

const LABEL: Record<string, string> = {
  ok: "Available",
  down: "Unavailable",
  unknown: "No health check",
};

export async function SolutionStatus({
  satellite,
  principal,
}: {
  satellite: Satellite;
  principal: Principal;
}) {
  const client = getPortal().clientFor(satellite);
  const { health, stats, figuresWithheld } = await satelliteOverview(
    {
      fetchManifest: () => client.fetchManifest(),
      checkHealth: (path) => client.checkHealth(path),
      fetchScreen: (screenId, params, who) => client.fetchScreen(screenId, params, who),
      // The same record the screen route writes, because it is the same read of
      // the same tenant-scoped data by the same hub — it merely arrived by the
      // front page. `params` is empty by construction; the summary screen is
      // refused at the protocol if it requires any.
      recordRead: ({ screenId, outcome, reason, latencyMs }) =>
        recordAudit(
          screenRead({
            ...auditStamp(),
            principal,
            auditKey: auditKeyFor(principal),
            satelliteId: satellite.id,
            screenId,
            params: {},
            outcome: reason === undefined ? { status: outcome } : { status: outcome, reason },
            latencyMs,
          }),
        ),
    },
    principal,
  );

  return (
    <>
      <p className="solutionHealth" data-status={health.status}>
        <span className="solutionPill" aria-hidden="true" />
        <span>{LABEL[health.status] ?? health.status}</span>
        {/* The reason, where there is one. A red pill that does not say why
            sends someone to a log to find out what the portal already knew. */}
        {health.detail !== undefined && <span className="solutionWhy">{health.detail}</span>}
        {health.status === "ok" && health.latencyMs !== undefined && (
          <span className="solutionWhy">{health.latencyMs} ms</span>
        )}
      </p>

      {figuresWithheld !== undefined && <p className="solutionWithheld">{figuresWithheld}</p>}

      {stats.length > 0 && (
        <dl className="solutionStats">
          {stats.map((stat, index) => (
            // Keyed by position, not by label: the label is a string the
            // satellite chose and nothing stops one screen carrying two tiles
            // that share it, which as a key is a duplicate React mis-reconciles.
            <div key={`${index}-${stat.label}`}>
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

/**
 * What stands in while the card is still asking.
 *
 * Shaped like the answer rather than a spinner, so the grid does not jump when
 * three satellites reply at three different times.
 */
export function SolutionStatusPending() {
  return (
    <p className="solutionHealth" data-status="pending">
      <span className="solutionPill" aria-hidden="true" />
      <span>Checking…</span>
    </p>
  );
}
