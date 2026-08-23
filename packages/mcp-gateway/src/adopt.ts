import { combine, satelliteLayer, toolPolicy, type Satellite } from "@portal/registry";
import type { SatelliteMcpTool } from "./client";
import { projectToolName } from "./names";
import type { ToolDescriptor } from "./shim";

/**
 * A satellite's own MCP tools, taken as they are.
 *
 * The shim derives tools from screens and actions; this does not derive
 * anything. A satellite that hosts MCP has said what it offers, and the
 * gateway's job shrinks to the two things a satellite cannot do for itself:
 * namespace the tool so two satellites can both have a `search`, and apply the
 * registry's policy so a human decides what an agent may reach.
 *
 * **Governance does not move.** `agentVisible`, `requiresConfirmation` and
 * `rbacScopes` still come from the registry file a person reviews — a satellite
 * declaring its own tool does not get to declare that a model may call it
 * unsupervised. That is the line PLAN.md draws between what a satellite owns
 * and what the platform owns, and MCP does not move it.
 */

/**
 * What a tool declares about itself when nothing declares anything.
 *
 * A screen's audience comes from the satellite's manifest, narrowed by the
 * registry. An MCP tool has no manifest entry, so this stands in for the
 * declaration: internal, and only internal. Inheriting the satellite's audience
 * instead would make every tool on an externally-visible satellite external the
 * moment it was declared — a satellite widening its own reach by shipping code.
 *
 * It is a *default*, not a ceiling. The registry may state an audience and that
 * replaces this one, because a person editing that file and a person reviewing
 * the diff is exactly the approval this is holding out for. What the registry
 * cannot do is exceed the satellite's own audience: `combine` intersects, so
 * the satellite layer below remains the cap it is everywhere else.
 */
const DEFAULT_AUDIENCE = { audience: ["internal"] as const };

export interface SkippedMcpTool {
  readonly toolId: string;
  readonly reason: string;
}

export interface AdoptResult {
  readonly tools: ToolDescriptor[];
  readonly skipped: SkippedMcpTool[];
}

export function adoptMcpTools(
  satellite: Satellite,
  tools: readonly SatelliteMcpTool[],
): AdoptResult {
  const adopted: ToolDescriptor[] = [];
  const skipped: SkippedMcpTool[] = [];

  for (const tool of tools) {
    const name = projectToolName(satellite.id, tool.name);
    if (name === undefined) {
      skipped.push({ toolId: tool.name, reason: "id is too long to project into an MCP tool name" });
      continue;
    }

    const policy = toolPolicy(satellite, tool.name);
    // One layer for the tool, not two. The registry's audience *replaces* the
    // default rather than narrowing it — passing both would intersect
    // `internal` with whatever the registry said, so a reviewed decision to
    // expose a tool externally could never take effect. Scopes still
    // accumulate, because `combine` unions them.
    const declared = {
      audience: policy?.audience ?? [...DEFAULT_AUDIENCE.audience],
      ...(policy?.rbacScopes === undefined ? {} : { rbacScopes: policy.rbacScopes }),
      // A native MCP tool has no manifest, so it declares no roles of its own —
      // it inherits the satellite's role ceiling, narrowed by any registry tool
      // policy named for it. `combine` handles the "no roles anywhere = un-gated"
      // case; this only forwards a registry-declared narrowing when present.
      ...(policy?.roles === undefined ? {} : { roles: policy.roles }),
    };
    const { audience, rbacScopes, roles } = combine([satelliteLayer(satellite), declared]);

    if (audience.length === 0) {
      skipped.push({ toolId: tool.name, reason: "registry and satellite agree on no audience" });
      continue;
    }

    adopted.push({
      name,
      satelliteId: satellite.id,
      source: "mcp",
      kind: tool.readOnly ? "read" : "write",
      targetId: tool.name,
      title: tool.title,
      description: tool.description,
      // The satellite's schema, unread. Nesting is the reason a satellite
      // reaches for MCP, and a gateway that flattened it here would have
      // removed the capability it exists to carry.
      inputSchema: tool.inputSchema,
      audience,
      rbacScopes,
      roles,
      // A tool that does not declare itself read-only is a write, and a write
      // pauses for a person unless the registry says otherwise.
      requiresConfirmation: policy?.requiresConfirmation ?? !tool.readOnly,
      agentVisible: policy?.agentVisible ?? tool.readOnly,
    });
  }

  return { tools: adopted, skipped };
}
