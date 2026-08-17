import { randomUUID } from "node:crypto";
import type { AuditEvent, Principal } from "@portal/identity";
import { anthropicClient, type ModelClient } from "@portal/agent";
import {
  buildSurface,
  invokeTool,
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

export function isAgentEnabled(principal?: Principal): boolean {
  // A key that is not there is not a misconfiguration to warn about — running
  // without an agent is a supported way to run this portal.
  if (!process.env["ANTHROPIC_API_KEY"]) return false;
  if (process.env["PORTAL_AGENT"] === "off") return false;
  if (principal !== undefined && disabledTenants().has(principal.tenantId)) return false;
  return true;
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
  const portal = getPortal();
  const audits: AuditEvent[] = [];

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
    audits,
    invoke: (name, args, options) =>
      invokeTool(surface, name, args, principal, {
        transport,
        onAudit: (event) => audits.push(event),
        now: () => Date.now(),
        at: () => new Date().toISOString(),
        newId: () => randomUUID(),
        confirmed: options.confirmed,
      }),
  };
}

export function modelClient(): ModelClient {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required to run the agent");
  return anthropicClient({ apiKey });
}
