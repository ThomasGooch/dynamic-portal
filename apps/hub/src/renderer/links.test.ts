import { describe, expect, it } from "vitest";
import { resolveLink } from "./links";

const ctx = { currentSatelliteId: "orders", allowedSatelliteIds: ["orders", "fleet"] };

describe("resolveLink", () => {
  it("resolves a bare screenId against the satellite the user is already in", () => {
    expect(resolveLink({ screenId: "orders.detail" }, ctx)).toEqual({
      kind: "internal",
      href: "/orders/orders.detail",
    });
  });

  it("resolves an explicit satelliteId, which is how cross-solution links work", () => {
    expect(resolveLink({ screenId: "fleet.map", satelliteId: "fleet" }, ctx)).toEqual({
      kind: "internal",
      href: "/fleet/fleet.map",
    });
  });

  it("appends params as query string", () => {
    const link = resolveLink({ screenId: "orders.detail", params: { id: "42" } }, ctx);
    expect(link).toEqual({ kind: "internal", href: "/orders/orders.detail?id=42" });
  });

  it("encodes params rather than letting them alter the path", () => {
    const link = resolveLink(
      { screenId: "orders.detail", params: { q: "a&b=c#d /e" } },
      ctx,
    );
    expect(link.kind).toBe("internal");
    if (link.kind !== "internal") return;
    expect(link.href.startsWith("/orders/orders.detail?")).toBe(true);
    expect(new URL(link.href, "http://h").searchParams.get("q")).toBe("a&b=c#d /e");
  });

  it("encodes a screen id containing a slash instead of emitting a second segment", () => {
    // `/orders/a/b` is a different route — the page 404s multi-segment paths —
    // so an unencoded slash turns a working link into a dead one.
    const link = resolveLink({ screenId: "a/b" }, ctx);
    expect(link).toEqual({ kind: "internal", href: "/orders/a%2Fb" });
  });

  it("refuses a satellite that is not in the allow-list", () => {
    // The list holds the satellites *this principal* may see. A satellite that
    // exists but is invisible must not become visible by being linked to: the
    // page 404s it anyway, so a live-looking link is only a broken promise.
    const link = resolveLink({ screenId: "s", satelliteId: "payroll" }, ctx);
    expect(link.kind).toBe("inert");
    if (link.kind !== "inert") return;
    expect(link.reason).toMatch(/payroll/);
  });

  it("refuses the current satellite too, if it somehow is not allowed", () => {
    const link = resolveLink({ screenId: "s" }, { ...ctx, allowedSatelliteIds: [] });
    expect(link.kind).toBe("inert");
  });

  it("passes an absolute https url through as external", () => {
    expect(resolveLink({ href: "https://example.com/docs" }, ctx)).toEqual({
      kind: "external",
      href: "https://example.com/docs",
    });
  });

  it("passes plain http through as external", () => {
    expect(resolveLink({ href: "http://example.com" }, ctx).kind).toBe("external");
  });

  for (const href of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "/relative/path",
    "//evil.example/x",
    "not a url",
  ]) {
    it(`refuses ${JSON.stringify(href)}`, () => {
      // The catalog already rejects these on arrival. The renderer checks again
      // because it is the last code that runs before an href reaches the DOM,
      // and it is the only one of the two that is not bypassable by a future
      // producer that forgets to validate.
      expect(resolveLink({ href }, ctx).kind).toBe("inert");
    });
  }

  it("refuses a link that is both internal and external", () => {
    // Picking one silently means the same declaration navigates two different
    // places depending on which branch happens to be checked first.
    const link = resolveLink({ screenId: "s", href: "https://example.com" }, ctx);
    expect(link.kind).toBe("inert");
    if (link.kind !== "inert") return;
    expect(link.reason).toMatch(/both/i);
  });

  it("refuses a link that names no destination at all", () => {
    expect(resolveLink({}, ctx).kind).toBe("inert");
  });

  it("resolves a satelliteId with no screenId to that satellite's landing route", () => {
    // `/fleet` is a real route — it lands on the first screen the principal may
    // see — so "take me to Fleet" needs no screen id to be a working link.
    expect(resolveLink({ satelliteId: "fleet" }, ctx)).toEqual({
      kind: "internal",
      href: "/fleet",
    });
  });

  it("still allow-list checks a satellite-only link", () => {
    expect(resolveLink({ satelliteId: "payroll" }, ctx).kind).toBe("inert");
  });
});
