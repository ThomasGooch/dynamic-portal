/**
 * Which model answers, whether anything answers at all, and how to say so.
 *
 * Split from `agent.ts` for a reason the build measures rather than a
 * preference. `instrumentation.ts` is compiled for the edge runtime as well as
 * for node — Next emits an "Edge Instrumentation" entry unconditionally — so
 * importing this from there once dragged `agent.ts`, and through it
 * `node:crypto`, `node:fs` and `node:path`, into a bundle that has none of
 * them: ten "not supported in the Edge Runtime" errors added to a build that
 * had zero. The `NEXT_RUNTIME` guard inside `register` cannot help, because
 * modules are evaluated before it runs, and a dynamic `await import()` does
 * not help either, because the tracer follows it too.
 *
 * So everything here reads `process.env` and nothing else. The clients that
 * need a filesystem or a socket stay in `agent.ts`, which re-exports this so
 * no caller has to know where the line falls.
 *
 * **Strictly additive, and off unless switched on.** PLAN.md makes this a
 * property rather than a preference: the deterministic portal has to work with
 * the agent disabled, per tenant as well as globally, which is at once an
 * availability property, a compliance control and a cost control. So the
 * default is off, a missing key is off, and a tenant on the disabled list is
 * off — and none of those paths touch anything the screens use.
 */

import { OLLAMA_MODEL, OLLAMA_URL } from "@portal/agent";
import type { Principal } from "@portal/identity";

/** Tenants that have not agreed to AI processing, or have withdrawn it. */
function disabledTenants(): ReadonlySet<string> {
  return new Set(
    (process.env["PORTAL_AGENT_DISABLED_TENANTS"] ?? "")
      .split(",")
      .map((tenant) => tenant.trim())
      .filter((tenant) => tenant !== ""),
  );
}

/**
 * Whether this tenant has agreed to be served by an agent at all.
 *
 * Split from `isAgentEnabled` because the two questions had been one, and the
 * combined answer was wrong for the outward MCP endpoint. That endpoint needs
 * no Azure config of ours — the model belongs to whoever is connecting — so
 * asking "is *our* agent configured" would have left it open to a tenant that
 * had withdrawn consent, which is the control's whole purpose. It is an
 * agent-facing surface either way, and consent governs the surface rather than
 * whose model reaches it.
 */
export function isAgentAllowedForTenant(principal: Principal): boolean {
  if (process.env["PORTAL_AGENT"] === "off") return false;
  return !disabledTenants().has(principal.tenantId);
}

/**
 * Whether *a* model is configured for the hub's own assistant.
 *
 * "Configured" is not "keyed". `PORTAL_MODEL_PROVIDER=ollama` needs no key of
 * ours — the model is on this machine — and asking only about the Azure vars
 * would have answered 404 "the assistant is not enabled" to the very setup
 * the local provider exists to make cheap. This has to agree with
 * `modelClient()` below: the two are the same question asked once for the
 * gate and once for the client, and a disagreement is either a dead assistant
 * or a throw inside the turn.
 *
 * Azure has no hardcoded default for the endpoint or deployment — unlike the
 * old Anthropic client, which only needed a key because the model name had
 * one — so all three of the key, endpoint and deployment are required here.
 */
function isModelConfigured(): boolean {
  if (isLocalProvider()) return true;
  // Missing config is not a misconfiguration to warn about — running without
  // an agent is a supported way to run this portal.
  return (
    Boolean(process.env["AZURE_OPENAI_API_KEY"]) &&
    set("PORTAL_AZURE_ENDPOINT") !== undefined &&
    set("PORTAL_AZURE_DEPLOYMENT") !== undefined
  );
}

export function isAgentEnabled(principal?: Principal): boolean {
  if (!isModelConfigured()) return false;
  if (principal !== undefined) return isAgentAllowedForTenant(principal);
  return process.env["PORTAL_AGENT"] !== "off";
}

/**
 * Which model answers, and why the default is the hosted one.
 *
 * `PORTAL_MODEL_PROVIDER=ollama` points the agent at a model on this machine.
 * That exists because testing the assistant against a metered API turned a
 * regression suite into a bill, which is a poor incentive to test the agent at
 * all.
 *
 * The default stays the hosted Azure AI Foundry deployment deliberately. A
 * local model is a different answer to the same question — not reviewed for
 * whatever data-handling terms this deployment is expected to meet — so it
 * turns on by choice and never by omission.
 */
/**
 * Trimmed, because this arrives from a `.env` file compose reads verbatim and
 * `PORTAL_MODEL_PROVIDER=ollama ` with a trailing space is not a typo anyone
 * can see.
 */
function provider(): string {
  return (process.env["PORTAL_MODEL_PROVIDER"] ?? "").trim();
}

function isLocalProvider(): boolean {
  return provider() === "ollama";
}

/**
 * What the agent will actually talk to, and where.
 *
 * A union rather than one shape with an optional `baseUrl`, because the local
 * provider always has an address and the hosted one has no address to give.
 * Written as an optional field it typechecked only with a `!` at the single
 * place it is read — an assertion that the compiler would have had to be told
 * to trust exactly where it could have proved it instead.
 */
export type ResolvedModel =
  | {
      readonly provider: "azure";
      readonly deployment: string;
      readonly endpoint: string;
      readonly apiVersion: string;
    }
  | { readonly provider: "ollama"; readonly model: string; readonly baseUrl: string };

/**
 * Empty is absent.
 *
 * Compose writes `VAR: ${VAR:-}` for every optional setting, so an unset
 * variable arrives as `""` rather than `undefined`, and `??` only catches
 * null. That once sent `model: ""` to Ollama, which rejected it in three
 * milliseconds while the hub reported only that the assistant "could not
 * complete that request".
 */
const set = (name: string): string | undefined => {
  // Trimmed, like the provider name above it. `PORTAL_OLLAMA_MODEL=` in a
  // compose file is how a passthrough looks when the host has not set it, and
  // some shells hand that through as whitespace rather than as empty. Neither
  // caller — a model name and a URL — ever means to carry padding, and an
  // untrimmed URL reaches `new URL()` as a parse error nobody explains.
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

/**
 * Resolves the model once, so nothing has to guess which one is answering.
 *
 * This exists because the answer was not obvious from the outside and I got it
 * wrong twice: the provider is chosen per `docker compose` invocation, an
 * omitted variable falls back to the paid API, and nothing said so. A hub that
 * silently bills is a hub whose configuration you learn from an invoice.
 *
 * `modelClient()` builds from this rather than reading the environment again,
 * which is the only arrangement where a startup log cannot drift from what
 * actually runs.
 */
export function resolveModel(): ResolvedModel {
  const chosen = provider();

  // A value nobody recognises used to fall through to the paid client, which
  // is the worst available answer: `PORTAL_MODEL_PROVIDER=ollma` asked for a
  // free model and quietly got a metered one, and the only evidence was the
  // invoice. This whole feature exists to stop testing costing money, so a
  // misspelling of it has to fail rather than bill.
  if (chosen !== "" && chosen !== "ollama" && chosen !== "azure") {
    throw new Error(
      `PORTAL_MODEL_PROVIDER="${chosen}" is not a provider. Use "ollama", or leave it unset for Azure.`,
    );
  }

  if (isLocalProvider()) {
    return {
      provider: "ollama",
      model: set("PORTAL_OLLAMA_MODEL") ?? OLLAMA_MODEL,
      baseUrl: set("PORTAL_OLLAMA_URL") ?? OLLAMA_URL,
    };
  }

  return {
    provider: "azure",
    // Empty when unset rather than a fallback: unlike Ollama there is no
    // universal default endpoint or deployment, so an unconfigured Azure
    // setup resolves to an empty string here and is caught by
    // `isModelConfigured()`/`isAgentEnabled()` before either is read.
    deployment: set("PORTAL_AZURE_DEPLOYMENT") ?? "",
    endpoint: set("PORTAL_AZURE_ENDPOINT") ?? "",
    // Empty when unset rather than a fallback version string: a live check
    // found the endpoint answers with no `api-version` at all, and the one
    // version string tried instead 400s with "API version not supported".
    apiVersion: set("PORTAL_AZURE_API_VERSION") ?? "",
  };
}

/**
 * A base URL with any credentials taken out of it.
 *
 * `PORTAL_OLLAMA_URL` is ordinarily a bare host and carries nothing secret,
 * but it is a URL a person writes, and `http://user:token@gpu-box:11434` is
 * how someone reaches a shared machine through a proxy. A startup line is
 * copied into issues and CI output, so it prints no part of a URL that a
 * reader would recognise as a password.
 */
function withoutCredentials(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL at all. `ollamaClient` will fail on it and say so; printing it
    // verbatim is what shows the typo, and a string this malformed has no
    // userinfo for `URL` to have found.
    return url;
  }

  if (parsed.username === "" && parsed.password === "") return url;
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

/**
 * One line, at startup, saying what will answer and what it costs.
 *
 * It reports the gate rather than the configuration, which are not the same
 * question. `PORTAL_MODEL_PROVIDER` unset with no Azure config resolves to
 * the hosted model and serves nothing at all — `isAgentEnabled()` is false
 * and the route answers 404 — and that is the *default* compose stack, since
 * `docker-compose.yml` passes the Azure vars through empty by default.
 * Describing the resolution alone would have printed "every turn is billed"
 * on the one configuration that bills nothing and has no assistant, which is
 * worse than printing nothing: a line that answers the question wrongly stops
 * it being asked.
 *
 * So the off-states are asked of the same predicates the route is gated on,
 * and the model sentence is reached only when there is a model to reach.
 */
export function describeModel(): string {
  // Asked before resolving: the kill switch means no model is consulted, so a
  // misspelt provider alongside it is not an error worth reporting here.
  if (process.env["PORTAL_AGENT"] === "off") return "assistant: off (PORTAL_AGENT=off)";

  const resolved = resolveModel();

  // The only way this is false past the switch above: the hosted provider
  // missing config. `isModelConfigured()` is unconditionally true for the
  // local one.
  if (!isAgentEnabled()) {
    return (
      "assistant: off (missing Azure config — set AZURE_OPENAI_API_KEY, " +
      "PORTAL_AZURE_ENDPOINT and PORTAL_AZURE_DEPLOYMENT, or " +
      "PORTAL_MODEL_PROVIDER=ollama for a local model)"
    );
  }

  const line =
    resolved.provider === "ollama"
      ? `assistant: ${resolved.model} on ${withoutCredentials(resolved.baseUrl)} (local, no API cost)`
      : `assistant: ${resolved.deployment} via Azure AI Foundry at ${withoutCredentials(resolved.endpoint)} (metered — every turn is billed)`;

  // Counted, never named. The consent list is tenant identifiers, and a
  // startup log is the wrong place to publish who a customer is; the fact that
  // the line does not describe every tenant is what a reader needs.
  const optedOut = disabledTenants().size;
  if (optedOut === 0) return line;
  return `${line}; off for ${optedOut} tenant${optedOut === 1 ? "" : "s"} (PORTAL_AGENT_DISABLED_TENANTS)`;
}
