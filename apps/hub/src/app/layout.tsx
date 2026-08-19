import type { ReactNode } from "react";
import { connection } from "next/server";
import { resolveNav } from "@portal/registry";
import { getPortal } from "@/lib/portal";
import { currentPrincipal, isDevSession } from "@/lib/session";
import { Toaster } from "@/components/Toaster";
import { AgentPanel } from "@/components/AgentPanel";
import { isAgentEnabled } from "@/lib/agent";
import "./globals.css";
import "./shell.css";
import "@/renderer/renderer.css";

export const metadata = {
  title: "Dynamic Portal",
  description: "One place for every solution.",
};

/**
 * The shell, rendered per request and never prerendered.
 *
 * Nav is resolved server-side from the registry for *this* principal, so a
 * satellite they cannot reach never reaches the browser — not hidden with CSS,
 * not filtered on the client, simply absent from the response.
 *
 * `await connection()` is how Next 16 expresses this: the `dynamic` route
 * segment option was removed in v16, so the old `export const dynamic =
 * "force-dynamic"` is silently no longer a thing. Prerendering stops at this
 * line.
 *
 * It matters here because these pages depend on the session and on live
 * satellite data. A prerendered page would bake one tenant's rows into HTML and
 * serve them to everyone — the exact failure the tenancy model exists to
 * prevent.
 */
/**
 * Which palette the portal wears, read at request time.
 *
 * A restart rather than a rebuild: both palettes ship in the stylesheet and
 * this only picks one, so rebranding costs a container restart and nothing is
 * recompiled. Absent means the default, because a portal with no brand
 * configured should look like the portal rather than fail to render.
 */
const brandFromEnvironment = (): string | undefined => {
  const brand = process.env["PORTAL_BRAND"];
  return brand === undefined || brand.trim() === "" ? undefined : brand.trim();
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  const principal = currentPrincipal();
  const brand = brandFromEnvironment();
  const nav = resolveNav(getPortal().registry, principal);

  return (
    <html lang="en" {...(brand === undefined ? {} : { "data-brand": brand })}>
      <body>
        <div className="shell">
          <nav className="nav">
            <div className="brand">
              Dynamic Portal
              <small>{principal.tenantId}</small>
            </div>

            {nav.length === 0 ? (
              <p className="navEmpty">No solutions are available to you.</p>
            ) : (
              nav.map((section) => (
                <div className="navSection" key={section.section}>
                  <h2>{section.section}</h2>
                  <ul>
                    {section.items.map((item) => (
                      <li key={item.satelliteId}>
                        <a href={`/${item.satelliteId}`}>{item.label}</a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}

            {isDevSession() && (
              <div className="sessionBanner">
                <strong>Development session</strong>
                Signed in as {principal.sub} ({principal.audience}). Replace with
                OIDC before deploying.
              </div>
            )}
          </nav>

          <main className="main">
            {/* Toasts live above the route so a satellite's `navigate` does not
                unmount the message it just raised. */}
            <Toaster>
              {children}

              {/* Additive, never load-bearing: when the agent is off for this
                  tenant nothing below is mounted and the portal above is
                  unchanged. PLAN.md makes that a property, not a preference.

                  Inside the provider, not beside it: the panel renders an
                  agent-composed screen with the same `ScreenRenderer` the
                  routes use, and that component calls `useToaster()`, which
                  throws outside a `<Toaster>`. The panel is `position: fixed`,
                  so its place in the tree costs nothing visually.

                  `owner` is who the panel's stored conversation belongs to. It
                  keeps a thread in `sessionStorage` from being drawn for
                  whoever signs in next on the same tab: the hub's signature
                  check refuses that history, but only once it is sent, and the
                  panel renders its tool results before then. Nothing about the
                  principal that the browser is not already entitled to — it is
                  the identity of the person being answered. */}
              {isAgentEnabled(principal) && (
                <AgentPanel owner={`${principal.tenantId}:${principal.sub}`} />
              )}
            </Toaster>
          </main>
        </div>
      </body>
    </html>
  );
}
