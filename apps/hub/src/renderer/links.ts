/**
 * Turning a satellite's link declaration into an href the hub is willing to put
 * in the DOM.
 *
 * Two rules, both of which exist because a link is the one place a satellite's
 * data becomes something the *browser* acts on.
 *
 * **Internal links are allow-listed.** The list holds the satellites this
 * principal may see, so a satellite cannot advertise a neighbour the user has
 * no access to. The page 404s such a route anyway; rendering a live-looking
 * link to it only turns a policy decision into a broken promise.
 *
 * **External links are scheme-checked, again.** The catalog already rejects
 * `javascript:` on arrival. This runs a second time because it is the last code
 * between an href and the DOM, and because the catalog check protects the
 * satellite path only — a future producer that forgets to validate reaches this
 * function regardless.
 */

export interface LinkTarget {
  readonly satelliteId?: string | undefined;
  readonly screenId?: string | undefined;
  readonly params?: Readonly<Record<string, string>> | undefined;
  readonly href?: string | undefined;
}

export interface LinkContext {
  /** The satellite whose screen is being rendered — the default for bare links. */
  readonly currentSatelliteId: string;
  /** Satellites this principal may see. Anything else resolves inert. */
  readonly allowedSatelliteIds: readonly string[];
}

export type ResolvedLink =
  | { readonly kind: "internal"; readonly href: string }
  | { readonly kind: "external"; readonly href: string }
  | { readonly kind: "inert"; readonly reason: string };

export function resolveLink(target: LinkTarget, ctx: LinkContext): ResolvedLink {
  const internal = target.screenId !== undefined || target.satelliteId !== undefined;

  if (internal && target.href !== undefined) {
    // Choosing one silently means the same declaration navigates two different
    // places depending on which branch happens to be tested first.
    return { kind: "inert", reason: "link names both a screen and an external url" };
  }

  if (target.href !== undefined) {
    return isHttpUrl(target.href)
      ? { kind: "external", href: target.href }
      : { kind: "inert", reason: "external link is not an absolute http(s) url" };
  }

  if (!internal) return { kind: "inert", reason: "link names no destination" };

  const satelliteId = target.satelliteId ?? ctx.currentSatelliteId;
  if (!ctx.allowedSatelliteIds.includes(satelliteId)) {
    return { kind: "inert", reason: `no satellite "${satelliteId}" is available to you` };
  }

  // `encodeURIComponent` and not a template hole: a screen id containing a
  // slash would otherwise emit a second path segment, and the screen route
  // 404s multi-segment paths — a working link silently becomes a dead one.
  const path =
    target.screenId === undefined
      ? `/${encodeURIComponent(satelliteId)}`
      : `/${encodeURIComponent(satelliteId)}/${encodeURIComponent(target.screenId)}`;

  const query = new URLSearchParams(target.params ?? {}).toString();
  return { kind: "internal", href: query === "" ? path : `${path}?${query}` };
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
