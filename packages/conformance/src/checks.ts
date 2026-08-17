import { validateNested } from "@portal/catalog";
import { signPrincipal, type Principal } from "@portal/identity";
import {
  ManifestSchema,
  ScreenResponseSchema,
  isSupportedProtocolVersion,
  type Manifest,
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
    scopes: [...(options.scopes ?? [])],
  };
  const token = signPrincipal(principal, options.principalSecret);

  const get = async (path: string, headers: Record<string, string> = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
    try {
      return await doFetch(`${base}${path}`, { headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

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
  const firstScreen = manifest.screens[0];

  if (firstScreen === undefined) {
    results.push(skip("authentication", "the satellite declares no screens to probe"));
  } else {
    const path = `/portal/screens/${encodeURIComponent(firstScreen.id)}`;

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

    if (firstScreen.audience.includes("external")) {
      results.push(
        skip(
          "refuses an undeclared audience",
          `${firstScreen.id} is published externally, so there is no audience to be refused`,
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
        // The satellite is enforcing scopes the probe does not hold, which is
        // correct behaviour on its part and ignorance on ours: required scopes
        // live in the hub's registry, which a satellite team may not have. A
        // failure here would blame the satellite for the probe not knowing.
        results.push(
          skip(
            `screen ${screen.id}`,
            "refused this probe's scopes; pass PORTAL_CONFORMANCE_SCOPES to check it",
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

/** A warning is not a failure. A skip is emphatically not a pass. */
function report(baseUrl: string, results: CheckResult[]): ConformanceReport {
  return { baseUrl, results, ok: !results.some((result) => result.status === "fail") };
}
