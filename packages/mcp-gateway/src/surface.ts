import { authorize, type Principal } from "@portal/identity";
import type { Manifest } from "@portal/protocol";
import type { Satellite } from "@portal/registry";
import { adoptMcpTools } from "./adopt";
import type { SatelliteMcpTool } from "./client";
import { indexToolNames } from "./names";
import { shimTools, type ToolDescriptor } from "./shim";

/**
 * What one principal may call, right now.
 *
 * The gateway does not decide who may read what. It asks `authorize` — the same
 * function the screen route asks — because a gateway with its own idea of
 * entitlement is a second policy engine, and two policy engines disagree
 * eventually. Enabling a tool in the registry says *the agent* may call it; it
 * says nothing about who the agent is acting for, and both have to be true.
 */

export interface SurfaceEntry {
  readonly satellite: Satellite;
  readonly manifest: Manifest;
  /**
   * What this satellite's own MCP server offers, if it hosts one.
   *
   * Adopted here rather than kept in a parallel surface, so that everything
   * below applies to both sources without being written twice: entitlement,
   * `agentVisible`, and — the one that would actually bite — name collisions.
   * A satellite that exposes `orders.list` as both a screen and an MCP tool has
   * two different things answering to one name, and this is where that gets
   * noticed instead of being resolved by whichever list was built first.
   */
  readonly mcpTools?: readonly SatelliteMcpTool[];
}

export interface SurfaceSkip {
  readonly satelliteId: string;
  readonly toolId: string;
  readonly reason: string;
}

export interface ToolSurface {
  /** Visible to this principal, in the order the satellites were given. */
  readonly tools: readonly ToolDescriptor[];
  readonly byName: ReadonlyMap<string, ToolDescriptor>;
  /**
   * Things that could have been tools and are not. A write that nobody enabled
   * is *not* here: "not enabled" is the resting state of every write, and
   * listing them would bury the ones that are actually broken.
   */
  readonly skipped: readonly SurfaceSkip[];
}

export function buildSurface(
  entries: readonly SurfaceEntry[],
  principal: Principal,
): ToolSurface {
  const all: ToolDescriptor[] = [];
  const skipped: SurfaceSkip[] = [];

  for (const { satellite, manifest, mcpTools } of entries) {
    const result = shimTools(satellite, manifest);
    all.push(...result.tools);
    for (const skip of result.skipped) {
      skipped.push({ satelliteId: satellite.id, ...skip });
    }

    if (mcpTools === undefined || mcpTools.length === 0) continue;
    const adopted = adoptMcpTools(satellite, mcpTools);
    all.push(...adopted.tools);
    for (const skip of adopted.skipped) {
      skipped.push({ satelliteId: satellite.id, ...skip });
    }
  }

  // Over *every* tool, before entitlement is considered. Running it after would
  // make a name ambiguous for one principal and unambiguous for another, so the
  // same name could resolve to different tools depending on who asked — which
  // is the collision, arrived at more quietly.
  const { index, collisions } = indexToolNames(
    all.map((tool) => ({ satelliteId: tool.satelliteId, toolId: tool.targetId })),
  );

  // Keyed on satellite *and* tool, joined by a character no id contains. Written
  // as the escape rather than the literal byte on purpose: a raw NUL in the
  // source makes git classify this file as binary, and a security-relevant file
  // that shows up in a pull request as "Binary files differ" does not get read.
  const dropped = new Set<string>();
  for (const collision of collisions) {
    for (const ref of collision.refs) {
      dropped.add(`${ref.satelliteId}\u0000${ref.toolId}`);
      skipped.push({
        satelliteId: ref.satelliteId,
        toolId: ref.toolId,
        reason: `tool name "${collision.name}" is claimed by ${collision.refs.length} ids at once`,
      });
    }
  }

  const tools = all.filter((tool) => {
    if (dropped.has(`${tool.satelliteId}\u0000${tool.targetId}`)) return false;
    if (!index.has(tool.name)) return false;
    if (!tool.agentVisible) return false;
    return authorize(principal, { audience: tool.audience, rbacScopes: tool.rbacScopes }).allowed;
  });

  return {
    tools,
    byName: new Map(tools.map((tool) => [tool.name, tool])),
    skipped,
  };
}
