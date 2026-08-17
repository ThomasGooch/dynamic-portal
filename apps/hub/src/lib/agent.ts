import { randomUUID } from "node:crypto";
import type { AuditEvent, Principal } from "@portal/identity";
import { anthropicClient, type ModelClient } from "@portal/agent";
import {
  buildSurface,
  invokeTool,
  type InvokeDeps,
  type ToolResult,
  type ToolSurface,
  type ToolTransport,
} from "@portal/mcp-gateway";
import { visibleSatellites } from "@portal/registry";
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
  readonly audits: readonly AuditEvent[];
}

/**
 * Everything the gateway needs except the confirmation decision — which belongs
 * to whoever is asking, not to this factory. The agent loop supplies it per
 * call; the MCP route never supplies it at all.
 *
 * Takes no principal and no surface, because it depends on neither: the gateway
 * hands the principal to each transport call itself. A factory that accepted
 * one anyway would read as though these dependencies were bound to an identity,
 * and dependencies that only look principal-bound are how a cached one ends up
 * serving the wrong tenant.
 */
export function agentInvokerDeps(): Omit<InvokeDeps, "confirmed"> {
  const portal = getPortal();

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

  return {
    transport,
    // Discarded, as everywhere else on this path, until the audit sink's
    // per-tenant key is decided. See the note on `agentInvoker`.
    onAudit: () => {},
    now: () => Date.now(),
    at: () => new Date().toISOString(),
    newId: () => randomUUID(),
  };
}

/**
 * The gateway, bound to one principal for one turn.
 *
 * Audit events are collected and, today, discarded. There is nowhere to write
 * them: PLAN.md leaves the per-tenant HMAC key for the digest as an open
 * decision, and a log that starts collecting before that is settled is a log
 * that has to be re-keyed later.
 *
 * Said plainly because the alternative is a comment implying the agent path is
 * audited when it is not. The gateway builds a valid event for every call
 * including the refusals; this is the seam a sink attaches to, and until one
 * does, the agent path has no audit trail.
 */
export function agentInvoker(principal: Principal, surface: ToolSurface): AgentInvoker {
  const audits: AuditEvent[] = [];
  const deps = agentInvokerDeps();

  return {
    audits,
    invoke: (name, args, options) =>
      invokeTool(surface, name, args, principal, {
        ...deps,
        // The one dependency this path does not discard: a turn's refusals are
        // what the confirmation card is rendered from.
        onAudit: (event) => audits.push(event),
        confirmed: options.confirmed,
      }),
  };
}

export function modelClient(): ModelClient {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required to run the agent");
  return anthropicClient({ apiKey });
}
