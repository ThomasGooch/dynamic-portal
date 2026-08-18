import { randomUUID } from "node:crypto";
import type { Principal } from "@portal/identity";
import { anthropicClient, ollamaClient, type ModelClient } from "@portal/agent";
import {
  buildSurface,
  invokeTool,
  type InvokeDeps,
  type ToolResult,
  type ToolSurface,
  type ToolTransport,
} from "@portal/mcp-gateway";
import { visibleSatellites } from "@portal/registry";
import { auditKeyFor, recordAudit } from "./audit";
import { getPortal } from "./portal";

/**
 * The agent, as the hub sees it.
 *
 * **Strictly additive, and off unless switched on.** PLAN.md makes this a
 * property rather than a preference: the deterministic portal has to work with
 * the agent disabled, per tenant as well as globally, which is at once an
 * availability property, a compliance control and a cost control. So the
 * default is off, a missing key is off, and a tenant on the disabled list is
 * off — and none of those paths touch anything the screens use.
 */

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
 * no `ANTHROPIC_API_KEY` — the model belongs to whoever is connecting — so
 * asking "is *our* agent configured" would have left it open to a tenant that
 * had withdrawn consent, which is the control's whole purpose. It is an
 * agent-facing surface either way, and consent governs the surface rather than
 * whose model reaches it.
 */
export function isAgentAllowedForTenant(principal: Principal): boolean {
  if (process.env["PORTAL_AGENT"] === "off") return false;
  return !disabledTenants().has(principal.tenantId);
}

export function isAgentEnabled(principal?: Principal): boolean {
  // A key that is not there is not a misconfiguration to warn about — running
  // without an agent is a supported way to run this portal.
  if (!process.env["ANTHROPIC_API_KEY"]) return false;
  if (principal !== undefined) return isAgentAllowedForTenant(principal);
  return process.env["PORTAL_AGENT"] !== "off";
}

/**
 * What this principal's agent may call.
 *
 * Rebuilt per request from the live manifests rather than cached, so a
 * satellite that changed what it offers is reflected on the next question.
 * A satellite that cannot be reached contributes nothing and does not fail the
 * turn — the same scoped degradation the nav and the screens already have.
 */
export async function buildAgentSurface(principal: Principal): Promise<ToolSurface> {
  const portal = getPortal();
  const satellites = visibleSatellites(portal.registry, principal);

  const entries = await Promise.all(
    satellites.map(async (satellite) => {
      const manifest = await portal.clientFor(satellite).fetchManifest();
      return manifest.ok ? { satellite, manifest: manifest.value } : undefined;
    }),
  );

  return buildSurface(
    entries.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
    principal,
  );
}

export interface AgentInvoker {
  readonly invoke: (
    name: string,
    args: Record<string, unknown>,
    options: { readonly confirmed: boolean },
  ) => Promise<ToolResult>;
  /** Waits for this turn's audit writes. See `InvokerDeps.flush`. */
  readonly flush: () => Promise<void>;
}

export interface InvokerDeps {
  readonly deps: Omit<InvokeDeps, "confirmed">;
  /**
   * Waits for every audit write this turn started.
   *
   * The gateway's `onAudit` is synchronous and writing a file is not, so the
   * writes are collected here and awaited before a response goes out. A
   * response that left before its record was on disk would make the log
   * "mostly complete", which is the one thing an audit log may not be.
   */
  readonly flush: () => Promise<void>;
}

/**
 * Everything the gateway needs except the confirmation decision — which belongs
 * to whoever is asking, not to this factory. The agent loop supplies it per
 * call; the MCP route never supplies it at all.
 *
 * It does take the principal, and only for one reason: the digest key is
 * derived per tenant. The transport still hands the principal to each call
 * itself, so nothing else here is bound to an identity.
 */
export function agentInvokerDeps(principal: Principal): InvokerDeps {
  const portal = getPortal();
  const pending: Promise<void>[] = [];

  const transport: ToolTransport = {
    fetchScreen: (satelliteId, screenId, params, who) => {
      const satellite = portal.registry.find((entry) => entry.id === satelliteId);
      if (satellite === undefined) throw new Error(`no satellite ${satelliteId}`);
      return portal.clientFor(satellite).fetchScreen(screenId, params, who);
    },
    invokeAction: (satelliteId, actionId, params, who) => {
      const satellite = portal.registry.find((entry) => entry.id === satelliteId);
      if (satellite === undefined) throw new Error(`no satellite ${satelliteId}`);
      return portal.clientFor(satellite).invokeAction(actionId, params, who);
    },
  };

  // The first write that failed, held until `flush` can throw it. A rejection
  // is caught the moment the write starts rather than when `flush` gets to it:
  // between the two there is a model round trip, and a promise that rejects
  // with no handler attached takes the whole process down under Node's default
  // `--unhandled-rejections=throw`. Failing the request is the intent; failing
  // the container is not.
  let failure: unknown;

  return {
    deps: {
      transport,
      auditKey: auditKeyFor(principal),
      // The gateway builds a valid event for every call including the refusals.
      // This is where they land — started here, awaited in `flush`.
      onAudit: (event) => {
        pending.push(
          recordAudit(event).catch((error: unknown) => {
            failure ??= error;
          }),
        );
      },
      now: () => Date.now(),
      at: () => new Date().toISOString(),
      newId: () => randomUUID(),
    },
    flush: async () => {
      await Promise.all(pending);
      if (failure !== undefined) throw failure;
    },
  };
}

/**
 * The gateway, bound to one principal for one turn.
 *
 * Every call it makes is recorded under this tenant's key, including the ones
 * it refuses — "nothing happened" and "an agent was stopped from doing this"
 * are the same entry in a log that only records successes.
 */
export function agentInvoker(principal: Principal, surface: ToolSurface): AgentInvoker {
  const { deps, flush } = agentInvokerDeps(principal);

  return {
    flush,
    invoke: (name, args, options) =>
      invokeTool(surface, name, args, principal, { ...deps, confirmed: options.confirmed }),
  };
}

/**
 * Which model answers, and why the default is the paid one.
 *
 * `PORTAL_MODEL_PROVIDER=ollama` points the agent at a model on this machine.
 * That exists because testing the assistant against a metered API turned a
 * regression suite into a bill, which is a poor incentive to test the agent at
 * all.
 *
 * The default stays Anthropic deliberately. PLAN.md picks `claude-opus-5`
 * because it is zero-data-retention eligible and regulated data reaches the
 * model through tool results — a compliance decision before a capability one.
 * A local model answers that question differently and nobody has reviewed it,
 * so it turns on by choice and never by omission.
 */
export function modelClient(): ModelClient {
  if (process.env["PORTAL_MODEL_PROVIDER"] === "ollama") {
    // Empty is absent. Compose writes `PORTAL_OLLAMA_MODEL: ${VAR:-}` for
    // every optional setting, so an unset variable arrives as "" rather than
    // undefined — and `??` only catches null. That sent `model: ""` to Ollama,
    // which rejected it in three milliseconds while the hub reported only that
    // the assistant "could not complete that request".
    const set = (name: string): string | undefined => {
      const value = process.env[name];
      return value === undefined || value === "" ? undefined : value;
    };

    const baseUrl = set("PORTAL_OLLAMA_URL");
    const model = set("PORTAL_OLLAMA_MODEL");
    return ollamaClient({
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(model === undefined ? {} : { model }),
    });
  }

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required to run the agent");
  return anthropicClient({ apiKey });
}
