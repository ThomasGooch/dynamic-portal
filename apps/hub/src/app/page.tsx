import { Suspense } from "react";
import { connection } from "next/server";
import { visibleSatellites } from "@portal/registry";
import { getPortal } from "@/lib/portal";
import { currentPrincipal } from "@/lib/session";
import { isAgentEnabled } from "@/lib/agent";
import { ComposedHome } from "@/components/ComposedHome";
import { SolutionStatus, SolutionStatusPending } from "@/components/SolutionStatus";

/**
 * The landing page: what exists, whether it is working, and what today looks like.
 *
 * Three layers, each degrading into the one below it rather than onto an error
 * page.
 *
 * **The cards** come from the registry alone — name, description, link, no I/O.
 * They render server-side and are a complete, usable front door on their own.
 *
 * **The status** fills in per card, inside its own `<Suspense>` boundary. A
 * satellite that is slow or stopped delays its own card and nothing else, which
 * is the blast-radius property the screens already have and the front page
 * would be the worst place to lose. The figures on a card are the stat tiles
 * from a screen the satellite nominated — so this page shows no number a team
 * is not already showing its own users, and adding a fourth solution needs no
 * change here.
 *
 * **`ComposedHome`** mounts last and asks the agent to read across everything
 * this account can see. Deliberately below, deliberately silent on failure:
 * with the assistant off, a tenant opted out, or the model unreachable, the
 * page is exactly what it was — additive, never load-bearing.
 */
export default async function Home() {
  await connection();
  const principal = currentPrincipal();
  const satellites = visibleSatellites(getPortal().registry, principal);

  return (
    <>
      <div className="screenHeader">
        <h1>Solutions</h1>
      </div>

      {satellites.length === 0 ? (
        <p>Nothing is available to your account.</p>
      ) : (
        <ul className="launcher">
          {satellites.map((satellite) => (
            <li key={satellite.id} className="solutionCard">
              <a href={`/${satellite.id}`}>
                <strong>{satellite.displayName}</strong>
                {satellite.description !== undefined && <span>{satellite.description}</span>}
              </a>

              {/*
                Keyed by satellite and given its own boundary, so the three
                requests are independent. A shared boundary would make the whole
                grid wait for the slowest satellite — which is the behaviour the
                error card on a screen exists to avoid, reintroduced one page up.
              */}
              <Suspense fallback={<SolutionStatusPending />}>
                <SolutionStatus satellite={satellite} principal={principal} />
              </Suspense>
            </li>
          ))}
        </ul>
      )}

      {/* Rendered only where the assistant is available at all, so a portal
          running without one does not ship a component that asks and hides. */}
      {isAgentEnabled(principal) && <ComposedHome />}
    </>
  );
}
