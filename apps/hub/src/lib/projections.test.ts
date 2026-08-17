import type { Principal } from "@portal/identity";
import { ManifestSchema, isAudienceSubset, type Audience } from "@portal/protocol";
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
 * anything to an audience *every* layer enclosing it was not marked for** — the
 * satellite, the screen or action, and the registry's tool policy alike. A
 * satellite-only check would miss the exact bug that prompted this file, where
 * one projection read the action's audience and skipped the policy's.
 * Everything else — scopes, confirmation — is checked in the packages that own
 * it. This is the one that reaches outside the organization when it is wrong.
 */

const AUDIENCES: readonly Audience[][] = [["internal"], ["external"], ["internal", "external"]];

const SCREEN_ID = "orders.list";
const ACTION_ID = "orders.approve";

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
    tools: { [ACTION_ID]: { agentVisible: true, audience: policyAudience } },
    ...(satelliteAudience.includes("external")
      ? {
          public: {
            service: "order-management",
            resources: [{ name: "orders", screenId: SCREEN_ID }],
            operations: [{ name: "approve", actionId: ACTION_ID }],
          },
        }
      : {}),
  });

  const manifest = ManifestSchema.parse({
    protocol: "1.1",
    satelliteId: "orders",
    displayName: "Orders",
    audience: satelliteAudience,
    screens: [{ id: SCREEN_ID, title: "Orders", audience: screenAudience }],
    actions: [
      {
        id: ACTION_ID,
        title: "Approve",
        params: [{ name: "id", type: "string", required: true }],
        audience: actionAudience,
      },
    ],
  });

  return { satellite, manifest };
}

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
          // The schemas already refuse a declaration wider than its satellite,
          // so those combinations describe a registry that cannot load.
          // Skipping them keeps this about the projections, not the parsers.
          if (![screen, action, policy].every((inner) => isAudienceSubset(inner, satellite))) {
            continue;
          }
          cases.push({ satellite, screen, action, policy });
        }
      }
    }
  }

  it("covers a meaningful spread of declarations", () => {
    // A guard on the guard: a filter that accidentally excluded everything
    // would leave this suite passing and testing nothing.
    expect(cases.length).toBeGreaterThan(10);
    expect(cases.some((entry) => entry.satellite.includes("external"))).toBe(true);
  });

  for (const entry of cases) {
    const label = `satellite=${entry.satellite} screen=${entry.screen} action=${entry.action} policy=${entry.policy}`;

    // Every layer enclosing one target id. Asserting against *these* rather than
    // against the satellite alone is what makes this a guard: the bug this file
    // was written for was a projection reading one inner declaration and
    // ignoring another, which a satellite-only check cannot see.
    const enclosing = (targetId: string): Audience[][] =>
      targetId === SCREEN_ID
        ? [entry.satellite, entry.screen]
        : [entry.satellite, entry.action, entry.policy];

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
          for (const declared of enclosing(tool.targetId)) {
            for (const audience of tool.audience) {
              expect(declared, `${label}: tool ${tool.name}`).toContain(audience);
            }
          }
          expect(tool.audience, `${label}: tool ${tool.name}`).toContain(principal.audience);
        }

        // The partner's projection. Checked per published thing, not per
        // service: a service is visible when the *satellite* allows it, so a
        // service-level assertion says nothing about the screen or the action.
        const catalog = buildCatalog([{ satellite, manifest }], principal);
        for (const service of catalog.services) {
          const published: [string, string][] = [
            ...service.resources.map((r): [string, string] => [SCREEN_ID, `resource ${r.name}`]),
            ...service.operations.map((o): [string, string] => [ACTION_ID, `operation ${o.name}`]),
          ];
          for (const [targetId, what] of published) {
            for (const declared of enclosing(targetId)) {
              // The façade's own rule, applied to every enclosing layer rather
              // than to the innermost one it happened to read.
              expect(declared, `${label}: ${what}`).toContain("external");
              expect(declared, `${label}: ${what}`).toContain(principal.audience);
            }
          }
        }

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
    // Every assertion in the sweep sits behind an `if` or a `for`, so a change
    // that quietly emptied both projections would satisfy all of them and prove
    // nothing. This walks the same cases again and counts.
    //
    // Recounted rather than accumulated across the tests above: counters
    // mutated by sibling tests fail whenever the file is run with a `-t`
    // filter or a shuffled order, which is a false alarm on the one test whose
    // job is to be trustworthy.
    let tools = 0;
    let services = 0;

    for (const entry of cases) {
      for (const principal of principals) {
        const { satellite, manifest } = fixture(
          entry.satellite,
          entry.screen,
          entry.action,
          entry.policy,
        );
        tools += buildSurface([{ satellite, manifest }], principal).tools.length;
        services += buildCatalog([{ satellite, manifest }], principal).services.length;
      }
    }

    expect(tools, "no tool was ever projected").toBeGreaterThan(0);
    expect(services, "no service was ever projected").toBeGreaterThan(0);
  });
});
