import {
  ActionResponseSchema,
  ManifestSchema,
  ScreenResponseSchema,
  isAudienceSubset,
  isRoleSubset,
  isSupportedProtocolVersion,
  type ActionResponse,
  type Manifest,
  type ScreenResponse,
  type UiNode,
} from "@portal/protocol";
import { validateNested } from "@portal/catalog";
import { signPrincipal, type Principal } from "@portal/identity";
import { CircuitBreaker } from "./breaker";
import type { Satellite } from "./registry";

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

/**
 * What the portal can say about a satellite without a user clicking anything.
 *
 * Three states, and the question they answer is "can this be used", not "is the
 * process alive". `down` therefore covers both a satellite that did not answer
 * and one the hub has stopped sending requests to — different causes, and the
 * `detail` below says which, but the same answer to the only question the front
 * page is asking.
 *
 * There was a fourth, `degraded`, for a satellite that answers its probe while
 * the hub's traffic to it fails. A review found it could not occur: the caller
 * reads the manifest first, that read goes through the same breaker, so by the
 * time health is probed the breaker is always closed. A state that cannot
 * happen is worse than one that does not exist, because it reads as coverage.
 */
export type HealthStatus = "ok" | "down" | "unknown";

export interface HealthReport {
  readonly status: HealthStatus;
  readonly latencyMs?: number;
  /** Why, when it is not `ok`. Safe to show: no upstream body reaches this. */
  readonly detail?: string;
}

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

  /**
   * Whether this satellite is up, and whether the hub's traffic to it is
   * working — which are different questions.
   *
   * `healthPath` has been in the manifest and all three SDKs since the
   * protocol was written, with nothing reading it. This is its first consumer,
   * and the reason the front page can say anything at all before a user clicks.
   *
   * **The breaker is not consulted at all, in either direction.** A liveness
   * probe is an observation, not traffic. Recording a success would let a
   * satellite with a cheap `/healthz` and broken screens have its circuit
   * reopened by every visit to the front page; recording a failure would let a
   * flaky probe take a working satellite's screens offline. And it is not
   * *read* either, since the only caller reaches this after a manifest fetch
   * that already required a closed circuit — reading it could return exactly
   * one answer.
   */
  async checkHealth(healthPath: string): Promise<HealthReport> {
    // Nothing here consults `#breaker`, and nothing here should: see the note
    // above. The one caller only arrives after a manifest fetch that already
    // required a closed circuit, so a probe never runs against an open one —
    // which is what makes the read pointless rather than merely unwanted.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#satellite.timeoutMs);
    const started = Date.now();

    try {
      const response = await this.#fetch(`${this.#satellite.baseUrl}${healthPath}`, {
        method: "GET",
        signal: controller.signal,
      });
      const latencyMs = Date.now() - started;

      // Nothing here reads the body, and an undrained one holds its socket
      // until the `Response` is collected — a probe per satellite per view is
      // enough of those to matter, and the next real request to that satellite
      // waits behind them. Only the status was ever wanted.
      void response.body?.cancel().catch(() => {});

      if (!response.ok) {
        return { status: "down", latencyMs, detail: `answered ${response.status}` };
      }

      return { status: "ok", latencyMs };
    } catch {
      const latencyMs = Date.now() - started;
      return controller.signal.aborted
        ? { status: "down", latencyMs, detail: `timed out after ${this.#satellite.timeoutMs}ms` }
        : { status: "down", latencyMs, detail: "could not be reached" };
    } finally {
      clearTimeout(timer);
    }
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
      // The same registry-wins rule for roles, and opt-in like everywhere else:
      // only when the registry declares a role ceiling for this satellite must
      // the manifest's satellite-level roles stay within it. Intersection at
      // decision time already prevents widening; this refuses the contradiction
      // at the door so it is a configuration error, not a silent narrowing.
      if (
        this.#satellite.roles !== undefined &&
        parsed.data.roles !== undefined &&
        !isRoleSubset(parsed.data.roles, this.#satellite.roles)
      ) {
        return {
          ok: false as const,
          detail: "manifest declares a role the registry does not grant this satellite",
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

  /**
   * Posts an action, as JSON or as the multipart body it arrived in.
   *
   * A `FormData` body is passed through untouched and its `content-type` is
   * left to `fetch`, which appends the boundary it generated. Setting the
   * header here would send a boundary that does not match the body, and every
   * satellite would read an empty form — the failure looks like "the file was
   * not attached" rather than "the header was wrong".
   */
  async invokeAction(
    actionId: string,
    payload: unknown,
    principal: Principal,
  ): Promise<Result<ActionResponse>> {
    const multipart = payload instanceof FormData;

    return this.#request(
      `/portal/actions/${encodeURIComponent(actionId)}`,
      {
        method: "POST",
        headers: multipart
          ? this.#authHeaders(principal)
          : { ...this.#authHeaders(principal), "content-type": "application/json" },
        body: multipart ? payload : JSON.stringify(payload ?? {}),
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
