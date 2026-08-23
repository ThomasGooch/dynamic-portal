import { validateNested } from "@portal/catalog";
import { signPrincipal, type Principal } from "@portal/identity";
import {
  ManifestSchema,
  ScreenResponseSchema,
  isSupportedProtocolVersion,
  type Manifest,
  type Role,
} from "@portal/protocol";

/**
 * Does this satellite actually speak the protocol?
 *
 * The conformance kit is the adoption story. A team integrating a solution
 * should find out what is wrong from a command they run, in a minute, rather
 * than from the hub failing strangely in an environment they cannot see. That
 * is most of what decides whether teams onboard at all, which is why PLAN.md
 * lists it beside the SDK rather than as tooling.
 *
 * Two things it is careful about.
 *
 * **It says what it could not check.** A screen behind a required parameter
 * cannot be fetched without inventing a value, and tenant isolation cannot be
 * proved from outside with one tenant's credentials. Those come back as
 * `skipped` with a reason, never as a pass — a green run that quietly omitted
 * the important half is worse than a red one.
 *
 * **It checks the rules a schema cannot.** That a satellite refuses an
 * unsigned request, refuses a forged signature, and refuses a principal from an
 * audience it did not declare are the claims the whole tenancy model rests on,
 * and none of them are visible in a manifest.
 */

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface ConformanceReport {
  readonly baseUrl: string;
  readonly results: readonly CheckResult[];
  readonly ok: boolean;
}

export interface ConformanceOptions {
  readonly baseUrl: string;
  /** The secret the satellite verifies principals with, in its test environment. */
  readonly principalSecret: string;
  /**
   * Scopes the probe should present.
   *
   * Empty by default and deliberately so: a satellite that serves a screen to a
   * scopeless principal has a problem worth seeing. Required scopes are
   * declared in the hub's registry rather than the manifest, so this tool
   * cannot discover them — an operator supplies them, and a screen refused
   * without them is reported as unchecked rather than broken.
   */
  readonly scopes?: readonly string[];
  /**
   * Roles the probe should present.
   *
   * Like scopes, whether a probe holds a role is an operator decision this tool
   * cannot discover from the manifest alone, so a screen refused for want of a
   * role is reported unchecked rather than broken. Absent leaves the probe with
   * no roles, which reaches every un-role-gated screen.
   */
  readonly roles?: readonly Role[];
  /**
   * The whole principal, replacing the one built from `scopes`.
   *
   * A full override rather than a merge: `scopes` is ignored when this is
   * supplied, because a caller handing over a complete identity means it, and
   * quietly grafting scopes onto it would produce a principal neither side
   * asked for.
   */
  readonly principal?: Principal;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

const DEFAULT_PRINCIPAL: Principal = {
  sub: "conformance@example.test",
  tenantId: "conformance",
  audience: "internal",
  scopes: [],
};

const pass = (name: string, detail: string): CheckResult => ({ name, status: "pass", detail });
const fail = (name: string, detail: string): CheckResult => ({ name, status: "fail", detail });
const warn = (name: string, detail: string): CheckResult => ({ name, status: "warn", detail });
const skip = (name: string, detail: string): CheckResult => ({ name, status: "skip", detail });

export async function runConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const results: CheckResult[] = [];
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const principal = options.principal ?? {
    ...DEFAULT_PRINCIPAL,
    // Blanks are dropped rather than passed through: `PrincipalSchema` requires
    // every scope to be non-empty, so one `""` — which is what splitting an
    // empty environment variable on "," produces — mints a token every
    // satellite rejects, and the run then reports the probe's own malformed
    // principal as a satellite that 401s its own screens.
    scopes: [...(options.scopes ?? [])].filter((scope) => scope.trim() !== ""),
    // Threaded like scopes: present only when the operator supplies them, so an
    // un-role-gated satellite needs no configuration and a gated screen is
    // reported unchecked rather than broken when they are absent.
    ...(options.roles !== undefined && options.roles.length > 0
      ? { roles: [...options.roles] }
      : {}),
  };
  const token = signPrincipal(principal, options.principalSecret);

  // `AbortSignal.timeout` rather than a cleared timer: a timer cleared once the
  // response resolves stops covering the body, and `response.json()` on a
  // satellite that sends headers and then stalls would hang the run forever —
  // the exact failure `timeoutMs` exists to bound.
  const get = async (path: string, headers: Record<string, string> = {}) =>
    doFetch(`${base}${path}`, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });

  // ---- the manifest ------------------------------------------------------
  let manifest: Manifest | undefined;

  try {
    const response = await get("/portal/manifest");
    if (!response.ok) {
      results.push(fail("manifest", `GET /portal/manifest answered ${response.status}`));
    } else {
      const parsed = ManifestSchema.safeParse(await response.json());
      if (!parsed.success) {
        results.push(
          fail(
            "manifest",
            parsed.error.issues
              .slice(0, 5)
              .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
              .join("; "),
          ),
        );
      } else {
        manifest = parsed.data;
        results.push(
          pass("manifest", `${manifest.screens.length} screens, ${manifest.actions.length} actions`),
        );
      }
    }
  } catch (error) {
    results.push(fail("manifest", `could not be fetched: ${(error as Error).message}`));
  }

  if (manifest === undefined) {
    // Everything else reads the manifest. Reporting twenty cascading failures
    // would bury the one that matters.
    results.push(skip("everything else", "no valid manifest to check against"));
    return report(base, results);
  }

  // ---- protocol version --------------------------------------------------
  results.push(
    isSupportedProtocolVersion(manifest.protocol)
      ? pass("protocol version", `declares ${manifest.protocol}`)
      : fail(
          "protocol version",
          `declares ${manifest.protocol}, which this hub no longer supports`,
        ),
  );

  // ---- authentication ----------------------------------------------------
  // None of this is visible in a manifest, and all of it is what stops a hub
  // bug from becoming a disclosure.
  // Probed on a screen that takes no required parameter. A satellite that
  // validates its query string before it authenticates answers 400 or 404 to a
  // parameterless request, and all three checks below would then report a
  // defect the satellite does not have.
  const probeScreen =
    manifest.screens.find((screen) => !(screen.params ?? []).some((param) => param.required)) ??
    manifest.screens[0];

  if (probeScreen === undefined) {
    results.push(skip("authentication", "the satellite declares no screens to probe"));
  } else {
    const path = `/portal/screens/${encodeURIComponent(probeScreen.id)}`;

    results.push(await expectStatus(get, path, {}, 401, "refuses an unsigned request"));
    results.push(
      await expectStatus(
        get,
        path,
        { authorization: "Bearer not.a.real.token" },
        401,
        "refuses a forged signature",
      ),
    );

    if (probeScreen.audience.includes("external")) {
      results.push(
        skip(
          "refuses an undeclared audience",
          `${probeScreen.id} is published externally, so there is no audience to be refused`,
        ),
      );
    } else {
      // A refusal only demonstrates an audience check if the *correctly*
      // audienced principal is accepted on the same path. A satellite refuses
      // for a missing scope with the same 403, so without this baseline a
      // satellite performing no audience check at all earns the tick — on the
      // default empty scopes, which is every first run.
      const baseline = await statusOrUndefined(get, path, { authorization: `Bearer ${token}` });

      if (baseline === undefined || baseline >= 400) {
        results.push(
          skip(
            "refuses an undeclared audience",
            baseline === undefined
              ? `${probeScreen.id} could not be probed`
              : `${probeScreen.id} refuses this probe's own principal with ${baseline}, so a ` +
                "refusal proves nothing about audience; pass PORTAL_CONFORMANCE_SCOPES",
          ),
        );
      } else {
        const foreign = signPrincipal(
          { ...principal, audience: "external" },
          options.principalSecret,
        );
        results.push(
          await expectStatus(
            get,
            path,
            { authorization: `Bearer ${foreign}` },
            403,
            "refuses an undeclared audience",
          ),
        );
      }
    }
  }

  // ---- screens render ----------------------------------------------------
  for (const screen of manifest.screens) {
    const required = (screen.params ?? []).filter((param) => param.required);
    if (required.length > 0) {
      results.push(
        skip(
          `screen ${screen.id}`,
          `needs ${required.map((param) => param.name).join(", ")}; a value cannot be invented`,
        ),
      );
      continue;
    }

    try {
      const response = await get(`/portal/screens/${encodeURIComponent(screen.id)}`, {
        authorization: `Bearer ${token}`,
      });

      if (response.status === 403) {
        // The satellite is refusing this probe, which is correct behaviour on
        // its part and ignorance on ours: required scopes live in the hub's
        // registry, which a satellite team may not have. A failure here would
        // blame the satellite for the probe not knowing. The two reasons for a
        // 403 are kept apart because only one of them has a remedy — no scope
        // this tool can be handed will make an `external`-only screen answer an
        // `internal` principal.
        results.push(
          skip(
            `screen ${screen.id}`,
            screen.audience.includes(principal.audience)
              ? "refused this probe's scopes or roles; pass PORTAL_CONFORMANCE_SCOPES / PORTAL_CONFORMANCE_ROLES to check it"
              : `is declared for ${screen.audience.join(", ")} and this probe is ` +
                `${principal.audience}; pass a principal from that audience to check it`,
          ),
        );
        continue;
      }

      if (!response.ok) {
        results.push(fail(`screen ${screen.id}`, `answered ${response.status}`));
        continue;
      }

      const parsed = ScreenResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        results.push(
          fail(
            `screen ${screen.id}`,
            parsed.error.issues[0]?.message ?? "does not match the protocol",
          ),
        );
        continue;
      }

      // The check that decides whether the hub can draw it at all.
      const catalog = validateNested(parsed.data.ui);
      results.push(
        catalog.ok
          ? pass(`screen ${screen.id}`, "renders")
          : fail(
              `screen ${screen.id}`,
              catalog.issues
                .slice(0, 3)
                .map((issue) => `${issue.path}: ${issue.message}`)
                .join("; "),
            ),
      );
    } catch (error) {
      results.push(fail(`screen ${screen.id}`, `could not be fetched: ${(error as Error).message}`));
    }
  }

  // ---- actions are callable by an agent ----------------------------------
  for (const action of manifest.actions) {
    results.push(
      action.params === undefined
        ? warn(
            `action ${action.id}`,
            "declares no parameters, so no agent can call it; add `params` to publish it",
          )
        : pass(`action ${action.id}`, `declares ${action.params.length} parameters`),
    );
  }

  // ---- health ------------------------------------------------------------
  if (manifest.healthPath === undefined) {
    results.push(warn("health", "no healthPath declared, so the hub cannot check liveness"));
  } else {
    try {
      const response = await get(manifest.healthPath);
      results.push(
        response.ok
          ? pass("health", `${manifest.healthPath} answers ${response.status}`)
          : fail("health", `${manifest.healthPath} answered ${response.status}`),
      );
    } catch (error) {
      results.push(fail("health", `${manifest.healthPath}: ${(error as Error).message}`));
    }
  }

  // ---- what this cannot prove -------------------------------------------
  results.push(
    skip(
      "tenant isolation",
      "needs two tenants' real records and both sets of credentials; run it in your own tests",
    ),
  );

  return report(base, results);
}

async function expectStatus(
  get: (path: string, headers?: Record<string, string>) => Promise<Response>,
  path: string,
  headers: Record<string, string>,
  expected: number,
  name: string,
): Promise<CheckResult> {
  try {
    const response = await get(path, headers);
    return response.status === expected
      ? pass(name, `answered ${expected}`)
      : fail(name, `answered ${response.status}, expected ${expected}`);
  } catch (error) {
    return fail(name, `could not be probed: ${(error as Error).message}`);
  }
}

/** The status of a probe, or `undefined` when the request never got one. */
async function statusOrUndefined(
  get: (path: string, headers?: Record<string, string>) => Promise<Response>,
  path: string,
  headers: Record<string, string>,
): Promise<number | undefined> {
  try {
    return (await get(path, headers)).status;
  } catch {
    return undefined;
  }
}

/** A warning is not a failure. A skip is emphatically not a pass. */
function report(baseUrl: string, results: CheckResult[]): ConformanceReport {
  return { baseUrl, results, ok: !results.some((result) => result.status === "fail") };
}
