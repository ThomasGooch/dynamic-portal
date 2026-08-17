import type { Principal } from "@portal/identity";
import { ManifestSchema, type Audience } from "@portal/protocol";
import { SatelliteSchema } from "@portal/registry";
import { buildSurface } from "@portal/mcp-gateway";
import { buildCatalog } from "@portal/public-api";
import { describe, expect, it } from "vitest";

/**
 * One rule, checked across every projection at once.
 *
 * This exists because the rule has been broken six times in six files, always
 * locally, always found by review. `entitle()` is the fix for the code; this is
 * the fix for the *class*. A seventh projection added without it fails here
 * rather than in someone's audit.
 *
 * The property is deliberately narrow and absolute: **no projection may expose
 * anything to an audience its satellite was not marked for.** Everything else —
 * scopes, tool policy, confirmation — is checked in the packages that own it.
 * This is the one that reaches outside the organization when it is wrong.
 */

const AUDIENCES: readonly Audience[][] = [["internal"], ["external"], ["internal", "external"]];

const principals: readonly Principal[] = (["internal", "external"] as const).map((audience) => ({
  sub: `${audience}@acme.example`,
  tenantId: "acme",
  audience,
  scopes: ["orders.read", "orders.write"],
}));

function fixture(
  satelliteAudience: Audience[],
  screenAudience: Audience[],
  actionAudience: Audience[],
  policyAudience: Audience[],
) {
  const satellite = SatelliteSchema.parse({
    id: "orders",
    displayName: "Orders",
    baseUrl: "http://localhost:4001",
    owner: "team",
    audience: satelliteAudience,
    rbacScopes: [],
    tools: { "orders.approve": { agentVisible: true, audience: policyAudience } },
    ...(satelliteAudience.includes("external")
      ? {
          public: {
            service: "order-management",
            resources: [{ name: "orders", screenId: "orders.list" }],
            operations: [{ name: "approve", actionId: "orders.approve" }],
          },
        }
      : {}),
  });

  const manifest = ManifestSchema.parse({
    protocol: "1.1",
    satelliteId: "orders",
    displayName: "Orders",
    audience: satelliteAudience,
    screens: [{ id: "orders.list", title: "Orders", audience: screenAudience }],
    actions: [
      {
        id: "orders.approve",
        title: "Approve",
        params: [{ name: "id", type: "string", required: true }],
        audience: actionAudience,
      },
    ],
  });

  return { satellite, manifest };
}

/**
 * The schemas already refuse a declaration wider than its satellite, so those
 * combinations describe a registry that cannot load. Skipping them keeps this
 * about the projections rather than about the parsers.
 */
const subset = (inner: Audience[], outer: Audience[]) =>
  inner.every((value) => outer.includes(value));

describe("no projection is wider than the satellite it projects", () => {
  const cases: {
    satellite: Audience[];
    screen: Audience[];
    action: Audience[];
    policy: Audience[];
  }[] = [];

  for (const satellite of AUDIENCES) {
    for (const screen of AUDIENCES) {
      for (const action of AUDIENCES) {
        for (const policy of AUDIENCES) {
          if (!subset(screen, satellite) || !subset(action, satellite)) continue;
          if (!subset(policy, satellite)) continue;
          cases.push({ satellite, screen, action, policy });
        }
      }
    }
  }

  // Counted, because every assertion above sits behind an `if`. A refactor that
  // quietly emptied both projections would satisfy all of them and prove
  // nothing — this is the check that the checks ran.
  const seen = { tools: 0, catalog: 0 };

  it("covers a meaningful spread of declarations", () => {
    // A guard on the guard: a filter that accidentally excluded everything
    // would leave this suite passing and testing nothing.
    expect(cases.length).toBeGreaterThan(10);
    expect(cases.some((entry) => entry.satellite.includes("external"))).toBe(true);
  });

  for (const entry of cases) {
    const label = `satellite=${entry.satellite} screen=${entry.screen} action=${entry.action} policy=${entry.policy}`;

    for (const principal of principals) {
      it(`${label} · ${principal.audience} principal`, () => {
        const { satellite, manifest } = fixture(
          entry.satellite,
          entry.screen,
          entry.action,
          entry.policy,
        );

        // The agent's projection.
        const surface = buildSurface([{ satellite, manifest }], principal);
        for (const tool of surface.tools) {
          for (const audience of tool.audience) {
            expect(satellite.audience, `${label}: tool ${tool.name}`).toContain(audience);
          }
          expect(tool.audience, `${label}: tool ${tool.name}`).toContain(principal.audience);
        }

        // The partner's projection.
        const catalog = buildCatalog([{ satellite, manifest }], principal);
        if (catalog.services.length > 0) {
          seen.catalog += 1;
          expect(satellite.audience, `${label}: catalog`).toContain("external");
          // Only a principal the satellite admits sees anything at all.
          expect(satellite.audience, `${label}: catalog`).toContain(principal.audience);
        }
        seen.tools += surface.tools.length;

        // The rule that matters most, stated once and directly: nothing an
        // internal-only satellite declared may reach an external caller,
        // through any projection.
        if (!satellite.audience.includes("external") && principal.audience === "external") {
          expect(surface.tools, `${label}: tools leaked externally`).toEqual([]);
          expect(catalog.services, `${label}: services leaked externally`).toEqual([]);
        }
      });
    }
  }

  it("actually exercised both projections, rather than finding them empty", () => {
    expect(seen.tools, "no tool was ever projected").toBeGreaterThan(0);
    expect(seen.catalog, "no service was ever projected").toBeGreaterThan(0);
  });
});
