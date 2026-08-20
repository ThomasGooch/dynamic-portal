import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { findSatellite, resolveNav } from "@portal/registry";
import { getPortal } from "@/lib/portal";
import { currentPrincipal } from "@/lib/session";
import { isAgentEnabled } from "@/lib/agent";
import { agentReach, REACH_DETAIL, REACH_LABEL } from "@/lib/integration";
import { ComposedHome } from "@/components/ComposedHome";
import { SolutionStatus, SolutionStatusPending } from "@/components/SolutionStatus";

/**
 * The landing page: what exists, whether it is working, and what today looks like.
 *
 * Three layers, each degrading into the one below it rather than onto an error
 * page.
 *
 * **The cards** come from the registry alone — name, description, link, no I/O.
 * They render server-side and are a complete, usable front door on their own,
 * grouped and ordered by `resolveNav`. That grouping used to be the sidebar's
 * job; when the sidebar went, the reading of those declarations came here
 * rather than going with it. `nav: { section, order }` is maintained by three
 * satellite teams, and a field nothing reads is a field that rots.
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
  const registry = getPortal().registry;
  // Already filtered to what this principal may see, grouped by section and
  // ordered within it — so a satellite they cannot reach never reaches the
  // browser, rather than being hidden once it is there.
  const sections = resolveNav(registry, principal);

  return (
    <>
      <div className="screenHeader">
        <h1>Solutions</h1>
      </div>

      {sections.length === 0 ? (
        <p>Nothing is available to your account.</p>
      ) : (
        sections.map((section) => (
          <section className="solutionSection" key={section.section}>
            {/* Shown only when there is more than one, because a lone heading
                over every card on the page labels nothing. */}
            {sections.length > 1 && <h2>{section.section}</h2>}

            <ul className="launcher">
              {section.items.map((item) => {
                const satellite = findSatellite(registry, item.satelliteId);
                if (satellite === undefined) return null;

                const reach = agentReach(satellite);

                return (
                  <li key={satellite.id} className="solutionCard">
                    <Link href={`/${satellite.id}`} prefetch={false}>
                      <span className="solutionTitle">
                        <strong>{satellite.displayName}</strong>
                        {/*
                          Outside the Suspense boundary below, deliberately.
                          How a solution is integrated comes from the registry
                          and needs no request, so it is on screen with the
                          name — and it must not flicker with the network the
                          way a health pill should.
                        */}
                        <span className="solutionTag" data-reach={reach} title={REACH_DETAIL[reach]}>
                          {REACH_LABEL[reach]}
                        </span>
                      </span>
                      {satellite.description !== undefined && (
                        <span className="solutionDescription">{satellite.description}</span>
                      )}
                    </Link>

                    {/*
                      Keyed by satellite and given its own boundary, so the
                      requests are independent. A shared boundary would make the
                      whole grid wait for the slowest satellite — which is the
                      behaviour the error card on a screen exists to avoid,
                      reintroduced one page up.
                    */}
                    <Suspense fallback={<SolutionStatusPending />}>
                      <SolutionStatus satellite={satellite} principal={principal} />
                    </Suspense>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}

      {/* Rendered only where the assistant is available at all, so a portal
          running without one does not ship a component that asks and hides. */}
      {isAgentEnabled(principal) && <ComposedHome />}
    </>
  );
}
