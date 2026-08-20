import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What the container probes to decide the hub is alive.
 *
 * In the integration tier because it reads a file, like the `.env.example`
 * check beside it.
 *
 * This exists because of a regression that nothing else could have caught. The
 * compose healthcheck ran `curl /` every five seconds, which was free while the
 * landing page was a list of links. The moment that page started asking every
 * satellite for its manifest, its health and its summary screen, the probe
 * became permanent load on the whole estate — and, because the summary read is
 * audited, a steady drip of `screen.read` records written by a machine and
 * attributed to a person. Measured: six audit entries every ten seconds with
 * nobody using the portal.
 *
 * Every test in the repository passed throughout. The only symptom was in a log
 * file and a network, so the guard has to be on the configuration itself.
 */

const compose = readFileSync(new URL("../../../../docker-compose.yml", import.meta.url), "utf8");

/** The hub service's block, up to the next top-level service. */
const hubService = (): string => {
  const start = compose.indexOf("\n  hub:");
  expect(start, "no hub service in docker-compose.yml").toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
};

const healthcheckUrl = (): string => {
  const block = hubService();
  const match = block.match(/healthcheck:[\s\S]*?test:\s*\[([^\]]+)\]/);
  expect(match, "the hub declares no healthcheck").not.toBeNull();
  const url = match![1]!.match(/"(https?:\/\/[^"]+)"/);
  expect(url, "the hub healthcheck does not curl a URL").not.toBeNull();
  return url![1]!;
};

describe("the hub's healthcheck", () => {
  it("asks a liveness endpoint, not a page that reads every satellite", () => {
    const url = healthcheckUrl();
    const path = new URL(url).pathname;

    expect(path).toBe("/healthz");
  });

  it("is not pointed at the landing page", () => {
    // Stated separately from the assertion above so the failure says *why*
    // rather than only that a string changed. Any route that renders solution
    // cards performs audited, tenant-scoped reads; a probe must perform none.
    const path = new URL(healthcheckUrl()).pathname;

    expect(
      path === "/" || path === "",
      "the healthcheck probes the landing page, which reads every satellite and writes an audit record per card",
    ).toBe(false);
  });

  it("has a route to answer it", () => {
    // A healthcheck pointed at a path the app does not serve fails closed and
    // loudly, which is the good direction — but it fails on every deploy, so
    // it is worth knowing here instead.
    const served = new URL("../app/healthz/route.ts", import.meta.url);
    expect(() => readFileSync(served, "utf8")).not.toThrow();
  });

  it("still refuses to answer under a brand the portal does not have", async () => {
    // The guard this route inherited when the probe moved off `/`.
    //
    // `brandAttributes()` lives at module scope in the layout, and the layout
    // does not run for a route handler — so pointing the healthcheck at
    // `/healthz` quietly took a container from "never goes green under a bad
    // PORTAL_BRAND" to "reports healthy while every page 500s". The route calls
    // it back, and this is what stops a later tidy-up removing the call: the
    // line looks like it does nothing.
    const { GET } = await import("../app/healthz/route");
    const before = process.env["PORTAL_BRAND"];

    try {
      process.env["PORTAL_BRAND"] = "Contoso";
      expect(() => GET()).toThrow(/is not a brand/);

      process.env["PORTAL_BRAND"] = "contoso";
      expect(GET().status).toBe(200);
    } finally {
      if (before === undefined) delete process.env["PORTAL_BRAND"];
      else process.env["PORTAL_BRAND"] = before;
    }
  });

  it("does not report on satellites", () => {
    // Comments stripped first. The route's own docblock explains that it does
    // not reach for the registry, and matching that sentence would have made
    // this assertion fail on correct code — the same "a comment is not a
    // declaration" mistake the palette guard had to be corrected for.
    const route = readFileSync(new URL("../app/healthz/route.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    // A hub marked unhealthy because a solution is down would contradict the
    // property the whole design rests on: one satellite failing is one card,
    // not an outage. Compose already gates startup on the satellites' own
    // healthchecks, so this route has no reason to reach for the registry.
    expect(route).not.toMatch(/getPortal|registry|clientFor|satellite/i);
  });
});
