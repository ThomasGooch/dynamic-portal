/**
 * Projecting portal ids into MCP tool names.
 *
 * Two grammars meet here and they do not agree. Portal ids are dotted and
 * lower-case (`orders.approve`); MCP tool names are `[a-zA-Z0-9_-]` and
 * bounded. Every projection is therefore lossy in principle, which makes
 * collision detection part of the projection rather than a caller's problem.
 *
 * The separator is `__`, chosen because no id the registry or a manifest
 * accepts can sanitize into it — `IdSchema` alternates alphanumeric runs with
 * *single* separators. That is what stops a satellite from naming a tool that
 * appears to belong to a different satellite, and it is asserted in the tests
 * rather than assumed here.
 */

/** MCP tool names are bounded; 64 is the limit the Messages API enforces. */
export const MAX_TOOL_NAME_LENGTH = 64;

const NAMESPACE_SEPARATOR = "__";

const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, "_");

/**
 * Returns the projected name, or `undefined` when there is no name to project
 * onto.
 *
 * Truncating instead would produce a name that collides with whatever else
 * truncates to it, and that collision surfaces as an agent calling the wrong
 * tool. Losing one tool loudly is the better failure.
 */
export function projectToolName(satelliteId: string, toolId: string): string | undefined {
  const name = `${sanitize(satelliteId)}${NAMESPACE_SEPARATOR}${sanitize(toolId)}`;
  return name.length > MAX_TOOL_NAME_LENGTH ? undefined : name;
}

export interface ToolRef {
  readonly satelliteId: string;
  readonly toolId: string;
}

export interface ToolNameCollision {
  readonly name: string;
  /**
   * Every ref that landed on this name — including refs from *different*
   * satellites, since `a.b` and `a_b` are both valid satellite ids and the same
   * namespace. That case is the more dangerous one: the tool an agent reached
   * would belong to another solution entirely, so the record has to be able to
   * say so rather than name one satellite.
   */
  readonly refs: readonly ToolRef[];
}

export interface ToolNameIndex {
  readonly index: ReadonlyMap<string, ToolRef>;
  /** Two or more ids projecting onto one name. All of them are dropped. */
  readonly collisions: readonly ToolNameCollision[];
  /** Ids with no projection at all — too long to fit a tool name. */
  readonly unprojectable: readonly ToolRef[];
}

export function indexToolNames(refs: readonly ToolRef[]): ToolNameIndex {
  const byName = new Map<string, ToolRef[]>();
  const unprojectable: ToolRef[] = [];

  for (const ref of refs) {
    const name = projectToolName(ref.satelliteId, ref.toolId);
    if (name === undefined) {
      unprojectable.push(ref);
      continue;
    }
    const existing = byName.get(name);
    if (existing === undefined) byName.set(name, [ref]);
    else existing.push(ref);
  }

  const index = new Map<string, ToolRef>();
  const collisions: ToolNameCollision[] = [];

  for (const [name, group] of byName) {
    if (group.length === 1) {
      index.set(name, group[0] as ToolRef);
      continue;
    }
    // Every colliding tool is dropped, not merely the later ones. Keeping the
    // first is arbitrary — which is "first" depends on the order manifests
    // happened to load — and it is the same wrong-tool outcome for whichever
    // caller expected the other.
    collisions.push({ name, refs: group });
  }

  return { index, collisions, unprojectable };
}
