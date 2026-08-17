import { notFound } from "next/navigation";
import { connection } from "next/server";
import { authorize } from "@portal/identity";
import { findSatellite, visibleSatellites } from "@portal/registry";
import { screenRead } from "@portal/identity";
import { auditKeyFor, auditStamp, recordAudit } from "@/lib/audit";
import { getPortal } from "@/lib/portal";
import { currentPrincipal } from "@/lib/session";
import { ErrorCard } from "@/components/ScreenView";
import { ScreenRenderer } from "@/renderer/ScreenRenderer";

/**
 * A satellite screen.
 *
 * The route is `/{satelliteId}/{screenId}` with the screen optional, so a bare
 * `/orders` lands on that satellite's first declared screen. Deep links are
 * plain URLs with real history — the thing iframes and micro-frontends make
 * awkward, and item 2 of PLAN.md's verification list.
 */
export default async function ScreenPage({
  params,
  searchParams,
}: {
  params: Promise<{ satelliteId: string; screen?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const { satelliteId, screen } = await params;
  const query = await searchParams;
  const principal = currentPrincipal();
  const portal = getPortal();

  // A screen id is one segment. Without this, `/orders/orders.list/anything`
  // silently renders `orders.list` and the trailing segments vanish — a
  // mistyped or truncated deep link answering 200 with a page that is not the
  // one the URL names.
  if (screen !== undefined && screen.length > 1) notFound();

  /**
   * A refusal, recorded.
   *
   * Only reached once a principal is established, and deliberately: audit
   * writes fail closed, so auditing a request from someone we cannot identify
   * would hand an unauthenticated caller a way to fill the disk and take the
   * hub down with it. "Someone unauthenticated knocked" is a job for the access
   * log; "this principal was refused this screen" is evidence, and that is what
   * this records.
   */
  const recordRefusal = async (reason: string): Promise<void> => {
    await recordAudit(
      screenRead({
        ...auditStamp(),
        principal,
        auditKey: auditKeyFor(principal),
        satelliteId,
        screenId: screen?.[0] ?? "(unspecified)",
        params: {},
        outcome: { status: "denied", httpStatus: 404, reason },
        latencyMs: 0,
      }),
    );
  };

  const satellite = findSatellite(portal.registry, satelliteId);
  // 404 rather than 403 when a principal may not see a satellite: a 403 would
  // confirm it exists, which is the same disclosure the satellites avoid on
  // another tenant's records.
  if (
    satellite === undefined ||
    !authorize(principal, {
      audience: satellite.audience,
      rbacScopes: satellite.rbacScopes,
    }).allowed
  ) {
    await recordRefusal("satellite not visible to this principal");
    // `notFound()` stays at the call site: it is what TypeScript reads as
    // terminating the branch, and an awaited `never` is not.
    notFound();
  }

  const client = portal.clientFor(satellite);

  const manifest = await client.fetchManifest();
  if (!manifest.ok) {
    return (
      <>
        <Header title={satellite.displayName} />
        <ErrorCard satelliteName={satellite.displayName} failure={manifest} />
      </>
    );
  }

  // The default screen is the first one *this principal may see*, not simply
  // the first declared. On a satellite widened to external, a first-declared
  // internal-only screen would otherwise greet every external visitor with a
  // refusal card instead of the first screen they can actually open.
  const reachable = manifest.value.screens.filter(
    (s) => authorize(principal, { audience: s.audience, rbacScopes: [] }).allowed,
  );

  const screenId = screen?.[0] ?? reachable[0]?.id;
  if (screenId === undefined) {
    await recordRefusal("no screen on this satellite is visible");
    notFound();
  }

  const declared = reachable.find((entry) => entry.id === screenId);
  // A screen the principal may not see 404s rather than 403s, for the same
  // reason an unauthorised satellite does: a 403 confirms it exists.
  if (declared === undefined) {
    await recordRefusal("screen not visible to this principal");
    notFound();
  }

  const params_: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") params_[key] = value;
  }

  const startedAt = Date.now();
  const result = await client.fetchScreen(screenId, params_, principal);

  // Recorded before anything is rendered, and awaited: if the read cannot be
  // recorded it does not count as having happened. See `lib/audit.ts` on why
  // this fails closed.
  await recordAudit(
    screenRead({
      ...auditStamp(),
      principal,
      auditKey: auditKeyFor(principal),
      satelliteId: satellite.id,
      screenId,
      params: params_,
      outcome: result.ok ? { status: "ok" } : { status: "error", reason: result.reason },
      latencyMs: Date.now() - startedAt,
    }),
  );

  if (!result.ok) {
    return (
      <>
        <Header title={declared.title} satellite={satellite.displayName} />
        <ErrorCard satelliteName={satellite.displayName} failure={result} />
      </>
    );
  }

  return (
    <>
      <Header
        title={result.value.screen.title}
        satellite={satellite.displayName}
        crumbs={result.value.screen.breadcrumbs?.map((c) => c.label)}
      />
      <ScreenRenderer
        ui={result.value.ui}
        satelliteId={satellite.id}
        screenId={screenId}
        params={params_}
        // The satellites this principal may see. Passed down so a `Link` to a
        // solution they cannot reach renders as inert text rather than as a
        // live link to a 404 — the same list the nav was built from, so the
        // two cannot disagree.
        allowedSatelliteIds={visibleSatellites(portal.registry, principal).map((s) => s.id)}
      />
    </>
  );
}

function Header({
  title,
  satellite,
  crumbs,
}: {
  // `| undefined` spelled out because the workspace enables
  // exactOptionalPropertyTypes: an omitted prop and one explicitly passed as
  // undefined are different types, and JSX passes the latter.
  title: string;
  satellite?: string | undefined;
  crumbs?: readonly string[] | undefined;
}) {
  const trail = [satellite, ...(crumbs ?? [])].filter(Boolean) as string[];
  return (
    <div className="screenHeader">
      {trail.length > 0 && <div className="crumbs">{trail.join(" / ")}</div>}
      <h1>{title}</h1>
    </div>
  );
}
