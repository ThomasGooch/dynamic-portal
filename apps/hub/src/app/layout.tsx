import type { ReactNode } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { currentPrincipal, isDevSession } from "@/lib/session";
import { Toaster } from "@/components/Toaster";
import { AgentPanel } from "@/components/AgentPanel";
import { isAgentEnabled } from "@/lib/agent";
import { brandAttributes } from "@/lib/brand";
import "./globals.css";
import "./shell.css";
import "@/renderer/renderer.css";

export const metadata = {
  title: "Dynamic Portal",
  description: "One place for every solution.",
};

/**
 * The shell: a bar with the way home, and the page.
 *
 * There was a sidebar listing every solution. It went when the landing page
 * started carrying a card per solution — the same list, twice on screen, and
 * the copy in the sidebar was the one with less to say. What it *declared* did
 * not go with it: `resolveNav` still groups and orders the cards on the front
 * page, so the `nav: { section, order }` in every registry entry and manifest
 * keeps the reader it always had. Deleting a panel is cheap; quietly orphaning
 * a declaration three satellites maintain is the expensive kind of tidying.
 *
 * The wordmark is the way back. With no sidebar it is the only persistent
 * navigation, so it is a real link rather than a heading that happens to sit in
 * the corner.
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
 * Which palette the portal wears, resolved once at startup.
 *
 * At module scope, not per request, which costs nothing — a brand is a
 * property of the deployment and already changes only when the container is
 * re-created — and which decides *when* a bad value is heard. An unrecognised `PORTAL_BRAND` throws
 * here, so the module fails to evaluate, every route 500s, and the compose
 * healthcheck never goes green: `docker compose up` stops on it and the log
 * says which names are valid. Verified by running the stack with
 * `PORTAL_BRAND=Contoso`. That is the loud end of the range on purpose. The
 * quiet end — serving the default palette under a brand attribute nothing
 * matches — is the failure that reaches a room full of people instead of a
 * terminal.
 *
 * The resolving lives in `@/lib/brand` rather than here so it can be called
 * without rendering a page — a claim nothing can call is a claim nothing can
 * check, and the environment-to-attribute step is the half of this feature the
 * e2e suite cannot assert against a stack that has no brand set.
 */
/**
 * Internal navigation keeps the document alive.
 *
 * A plain `<a href>` replaces the whole document, which takes the assistant
 * panel with it — ask a question, click into a solution while it thinks, and
 * the request dies with the page. The conversation survived that already
 * (`sessionStorage`), but the in-flight turn could not, so the panel had to say
 * "the page changed before this answer arrived".
 *
 * `<Link>` navigates within the same layout, so the panel — which lives in the
 * layout — is never unmounted and its `fetch` resolves normally. This is also
 * what the renderer already does for an action's `navigate`: `router.push`.
 * Links were the one path still reloading the world.
 *
 * `prefetch={false}` deliberately. Next prefetches a link when it scrolls into
 * view, and a prefetched screen route is a *real* screen read: it reaches the
 * satellite and writes an audit entry. Solutions nobody clicked would appear in
 * the log as read, which is the same defect the healthcheck had — a machine
 * generating records that read as a person's activity.
 */
const BRAND_ATTRIBUTES = brandAttributes();

export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  const principal = currentPrincipal();

  return (
    <html lang="en" {...BRAND_ATTRIBUTES}>
      <body>
        <div className="shell">
          <header className="topbar">
            <div className="topbarInner">
              {/* Every screen in the portal is under this. It is the only
                  navigation that survives a satellite being unreachable, which
                  is exactly when someone needs a way out of the page they are
                  looking at. */}
              <Link className="brand" href="/" prefetch={false}>
                Dynamic Portal
              </Link>

              <div className="topbarMeta">
                <span className="tenantTag">{principal.tenantId}</span>
                {isDevSession() && (
                  <span
                    className="sessionBanner"
                    title={`Signed in as ${principal.sub} (${principal.audience}). Replace with OIDC before deploying.`}
                  >
                    Development session
                  </span>
                )}
              </div>
            </div>
          </header>

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
