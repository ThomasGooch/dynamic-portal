import { connection } from "next/server";
import { visibleSatellites } from "@portal/registry";
import { getPortal } from "@/lib/portal";
import { currentPrincipal } from "@/lib/session";
import { isAgentEnabled } from "@/lib/agent";
import { ComposedHome } from "@/components/ComposedHome";

/**
 * The landing page: a launcher, and a screen nobody wrote.
 *
 * The list below is server-rendered and complete on its own. `ComposedHome`
 * mounts after it and asks the agent to read across every solution this
 * account can see — the M2 capability PLAN.md describes, and the clearest
 * answer to "what is the hub for beyond consistent styling", because no
 * satellite could produce that view and no team maintains it.
 *
 * It is deliberately below the launcher and deliberately silent on failure.
 * With the assistant off, a tenant opted out, or the model unreachable, this
 * page is exactly what it was before — additive, never load-bearing.
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
            <li key={satellite.id}>
              <a href={`/${satellite.id}`}>
                <strong>{satellite.displayName}</strong>
                {satellite.description !== undefined && <span>{satellite.description}</span>}
              </a>
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
