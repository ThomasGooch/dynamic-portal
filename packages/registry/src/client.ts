import {
  ActionResponseSchema,
  ManifestSchema,
  ScreenResponseSchema,
  isAudienceSubset,
  isSupportedProtocolVersion,
  type ActionResponse,
  type Manifest,
  type ScreenResponse,
  type UiNode,
} from "@portal/protocol";
import { validateNested } from "@portal/catalog";
import { signPrincipal, type Principal } from "@portal/identity";
import { CircuitBreaker } from "./breaker.js";
import type { Satellite } from "./registry.js";

/**
 * The hub's side of the conversation with one satellite.
 *
 * This is the trust boundary. Everything a satellite says is validated here —
 * against the protocol *and* the catalog — before it can reach a browser. A
 * malformed screen forwarded onward becomes a broken page in front of a user
 * rather than a diagnosable failure at the edge, so it is treated as a fault of
 * the satellite, not as content.
 */

export type Failure =
  | { readonly ok: false; readonly reason: "unavailable"; readonly retryAfterMs: number }
  | { readonly ok: false; readonly reason: "timeout" }
  | { readonly ok: false; readonly reason: "not-found" }
  | { readonly ok: false; readonly reason: "forbidden" }
  | { readonly ok: false; readonly reason: "invalid-response"; readonly detail: string }
  | { readonly ok: false; readonly reason: "upstream-error"; readonly status: number };

export type Result<T> = { readonly ok: true; readonly value: T } | Failure;

export interface SatelliteClientOptions {
  readonly satellite: Satellite;
  readonly principalSecret: string;
  readonly fetch?: typeof fetch;
  readonly breaker?: CircuitBreaker;
}

export class SatelliteClient {
  readonly #satellite: Satellite;
  readonly #principalSecret: string;
  readonly #fetch: typeof fetch;
  readonly #breaker: CircuitBreaker;

  constructor(options: SatelliteClientOptions) {
    this.#satellite = options.satellite;
    this.#principalSecret = options.principalSecret;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#breaker = options.breaker ?? new CircuitBreaker();
  }

  get satelliteId(): string {
    return this.#satellite.id;
  }

  get breaker(): CircuitBreaker {
    return this.#breaker;
  }

  async fetchManifest(): Promise<Result<Manifest>> {
    // The manifest carries no tenant data, so it needs no principal.
    return this.#request("/portal/manifest", { method: "GET" }, (body) => {
      const parsed = ManifestSchema.safeParse(body);
      if (!parsed.success) {
        return { ok: false as const, detail: describe(parsed.error.issues) };
      }
      const unsupported = checkProtocol(parsed.data.protocol);
      if (unsupported !== undefined) return { ok: false as const, detail: unsupported };

      // The manifest is the satellite's *self*-declaration; the registry is the
      // hub's. Where they disagree the registry wins, because it is the file
      // that was reviewed. Without this, a satellite could name itself another
      // satellite's id — attributing its screens to that team — or declare
      // itself ["internal", "external"] while the registry says internal-only,
      // and any projection filtering on the manifest would publish internal
      // screens outside the org.
      if (parsed.data.satelliteId !== this.#satellite.id) {
        return {
          ok: false as const,
          detail: `manifest declares satelliteId "${parsed.data.satelliteId}" but the registry knows this satellite as "${this.#satellite.id}"`,
        };
      }
      if (!isAudienceSubset(parsed.data.audience, this.#satellite.audience)) {
        return {
          ok: false as const,
          detail: "manifest declares an audience the registry does not grant this satellite",
        };
      }
      return { ok: true as const, value: parsed.data };
    });
  }

  async fetchScreen(
    screenId: string,
    params: Readonly<Record<string, string>>,
    principal: Principal,
  ): Promise<Result<ScreenResponse>> {
    const query = new URLSearchParams(params).toString();
    const path = `/portal/screens/${encodeURIComponent(screenId)}${query ? `?${query}` : ""}`;

    return this.#request(
      path,
      { method: "GET", headers: this.#authHeaders(principal) },
      (body) => {
        const parsed = ScreenResponseSchema.safeParse(body);
        if (!parsed.success) {
          return { ok: false as const, detail: describe(parsed.error.issues) };
        }
        const unsupported = checkProtocol(parsed.data.protocol);
        if (unsupported !== undefined) return { ok: false as const, detail: unsupported };
        const catalog = checkCatalog(parsed.data.ui);
        return catalog === undefined
          ? { ok: true as const, value: parsed.data }
          : { ok: false as const, detail: catalog };
      },
    );
  }

  async invokeAction(
    actionId: string,
    payload: unknown,
    principal: Principal,
  ): Promise<Result<ActionResponse>> {
    return this.#request(
      `/portal/actions/${encodeURIComponent(actionId)}`,
      {
        method: "POST",
        headers: { ...this.#authHeaders(principal), "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
      },
      (body) => {
        const parsed = ActionResponseSchema.safeParse(body);
        if (!parsed.success) {
          return { ok: false as const, detail: describe(parsed.error.issues) };
        }
        const unsupported = checkProtocol(parsed.data.protocol);
        if (unsupported !== undefined) return { ok: false as const, detail: unsupported };
        // A patch carries a subtree across the same boundary as a screen, so it
        // is held to the same vocabulary.
        for (const patch of parsed.data.patch ?? []) {
          const catalog = checkCatalog(patch.ui);
          if (catalog !== undefined) return { ok: false as const, detail: catalog };
        }
        return { ok: true as const, value: parsed.data };
      },
    );
  }

  /**
   * The hub presents an identity it has minted; it does not assert one. The
   * satellite verifies the signature itself, which is what makes a hub bug an
   * availability incident rather than a cross-tenant disclosure.
   */
  #authHeaders(principal: Principal): Record<string, string> {
    return { authorization: `Bearer ${signPrincipal(principal, this.#principalSecret)}` };
  }

  async #request<T>(
    path: string,
    init: RequestInit,
    validate: (body: unknown) => { ok: true; value: T } | { ok: false; detail: string },
  ): Promise<Result<T>> {
    if (!this.#breaker.allowsRequest()) {
      return {
        ok: false,
        reason: "unavailable",
        retryAfterMs: this.#breaker.retryAfterMs(),
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#satellite.timeoutMs);

    // The deadline has to cover reading the body, not just receiving the
    // headers. A satellite that answers `200` and then stalls mid-body would
    // otherwise hold the hub's request open forever, which is exactly the hang
    // `timeoutMs` exists to prevent.
    try {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#satellite.baseUrl}${path}`, {
          ...init,
          signal: controller.signal,
        });
      } catch {
        // Abort and transport failure are indistinguishable to a caller and are
        // both the satellite's problem, so both count against the breaker.
        this.#breaker.recordFailure();
        return { ok: false, reason: "timeout" };
      }

      // A 4xx is the satellite answering correctly — "no such order", "not for
      // you", "that query is malformed". Counting it against the breaker would
      // take a healthy satellite offline because a user followed a stale link.
      // It is also proof the satellite is alive, so it *closes* the circuit:
      // without recording an outcome at all, a half-open probe that lands on a
      // 404 stays outstanding and the breaker refuses everything until the
      // probe expires — once per cooldown, forever, against a healthy
      // satellite. 408 and 429 are excluded: those are the satellite saying it
      // is struggling, which is precisely what the breaker should back off on.
      if (isSatelliteAnswer(response.status)) {
        this.#breaker.recordSuccess();
        if (response.status === 404) return { ok: false, reason: "not-found" };
        if (response.status === 401 || response.status === 403) {
          return { ok: false, reason: "forbidden" };
        }
        // The upstream body may contain a stack trace or internal paths, so
        // only the status crosses back.
        return { ok: false, reason: "upstream-error", status: response.status };
      }

      if (!response.ok) {
        this.#breaker.recordFailure();
        return { ok: false, reason: "upstream-error", status: response.status };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        this.#breaker.recordFailure();
        return controller.signal.aborted
          ? { ok: false, reason: "timeout" }
          : { ok: false, reason: "invalid-response", detail: "response was not JSON" };
      }

      const validated = validate(body);
      if (!validated.ok) {
        // Garbage is a fault, not an answer: a satellite that cannot hold to the
        // protocol is unwell, and repeating the request will not help.
        this.#breaker.recordFailure();
        return { ok: false, reason: "invalid-response", detail: validated.detail };
      }

      this.#breaker.recordSuccess();
      return { ok: true, value: validated.value };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Whether a status is the satellite answering rather than failing.
 *
 * 408 and 429 are 4xx but are not answers — they are the satellite reporting
 * that it could not keep up, so they stay on the failure path.
 */
function isSatelliteAnswer(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function checkProtocol(version: string): string | undefined {
  // Well-formedness is the schema's job; the support window is policy, and the
  // proxy is the last place that can apply it. A satellite two majors ahead
  // parses cleanly against today's schemas and would be rendered as if it were
  // current, silently.
  return isSupportedProtocolVersion(version)
    ? undefined
    : `protocol version "${version}" is outside the supported window`;
}

function checkCatalog(ui: UiNode): string | undefined {
  const result = validateNested(ui);
  if (result.ok) return undefined;
  return summarise(result.issues.map((i) => `${i.path}: ${i.message}`));
}

function describe(issues: readonly { path: (string | number)[]; message: string }[]): string {
  return summarise(issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
}

/** How many issues, and how much of each, may cross back to the caller. */
const MAX_REPORTED_ISSUES = 10;
const MAX_DETAIL_LENGTH = 2000;

/**
 * Issue text quotes satellite-controlled strings — a node's `type`, a prop
 * name — and a tree can carry thousands of bad nodes. Unbounded, a hostile or
 * merely broken satellite turns one response into a multi-megabyte string that
 * is then logged and rendered. The failure is diagnosable from the first few.
 */
function summarise(lines: readonly string[]): string {
  const shown = lines.slice(0, MAX_REPORTED_ISSUES);
  const remaining = lines.length - shown.length;
  const joined = shown.join("; ").slice(0, MAX_DETAIL_LENGTH);
  return remaining > 0 ? `${joined} (and ${remaining} more)` : joined;
}
