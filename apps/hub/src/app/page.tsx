import { connection } from "next/server";
import { visibleSatellites } from "@portal/registry";
import { getPortal } from "@/lib/portal";
import { currentPrincipal } from "@/lib/session";

/**
 * The landing page.
 *
 * A deliberately plain launcher for now. `PLAN.md` calls for an agent-composed
 * "needs attention" home, which lands with the agent in M2 — building a static
 * dashboard first would only be something to throw away.
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
        <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: "var(--gap-sm)" }}>
          {satellites.map((satellite) => (
            <li key={satellite.id}>
              <a
                href={`/${satellite.id}`}
                style={{
                  display: "block",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  background: "var(--surface)",
                  padding: "var(--gap-md)",
                  textDecoration: "none",
                }}
              >
                <strong>{satellite.displayName}</strong>
                {satellite.description !== undefined && (
                  <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
                    {satellite.description}
                  </div>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
