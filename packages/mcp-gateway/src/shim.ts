import type { Audience, Manifest } from "@portal/protocol";
import { combine, satelliteLayer, toolPolicy, type Satellite } from "@portal/registry";
import { indexToolNames, projectToolName } from "./names";

/**
 * The PUP → tool projection.
 *
 * This is what makes "most satellites, not all" true: a solution that ships no
 * MCP server is still agent-reachable, because its screens and actions already
 * describe everything a tool definition needs. Screens become reads, actions
 * become writes, and the satellite is not asked to do anything twice.
 *
 * **The one place the zero-hub-deploy promise deliberately does not apply.**
 * A read is agent-visible by default: it is bounded by the same audience and
 * scopes the screen route enforces, the satellite checks them again, and
 * requiring a registry entry per screen would mean adding a screen needed a hub
 * deploy after all. A *write* is invisible by default and must be named in the
 * registry, because exposing a mutation to a model is a governance decision and
 * belongs in the file a human reviews — not inherited from a satellite team
 * adding an endpoint.
 */

export type ToolKind = "read" | "write";

export type JsonPropertySchema =
  | {
      readonly type: "string" | "number" | "boolean";
      readonly description?: string;
      readonly enum?: readonly string[];
    }
  /**
   * A list of strings, and only that.
   *
   * `items` carries the element's own `enum` rather than the array's, because
   * a list constrained to a set constrains each entry — a model that read the
   * choices as constraining the array would think one value was the whole
   * answer.
   */
  | {
      readonly type: "array";
      readonly items: { readonly type: "string"; readonly enum?: readonly string[] };
      readonly description?: string;
    };

/**
 * Deliberately expressible only in what structured outputs accept: types,
 * requiredness, enumerated choices, and `additionalProperties: false`. No
 * lengths, ranges, patterns or formats — the same rule the catalog follows, so
 * one definition serves both the agent's strict schema and an ordinary MCP
 * client instead of two that drift.
 */
export interface JsonObjectSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonPropertySchema>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export interface ToolDescriptor {
  readonly name: string;
  readonly satelliteId: string;
  readonly kind: ToolKind;
  /** The screen or action id this tool dispatches to. */
  readonly targetId: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonObjectSchema;
  readonly audience: readonly Audience[];
  readonly rbacScopes: readonly string[];
  readonly requiresConfirmation: boolean;
  readonly agentVisible: boolean;
}

export interface SkippedTool {
  readonly toolId: string;
  readonly reason: string;
}

export interface ShimResult {
  readonly tools: readonly ToolDescriptor[];
  /** Things that could have been tools and are not, each with a reason. */
  readonly skipped: readonly SkippedTool[];
}

export function shimTools(satellite: Satellite, manifest: Manifest): ShimResult {
  const tools: ToolDescriptor[] = [];
  const skipped: SkippedTool[] = [];

  for (const screen of manifest.screens) {
    const tool = build({
      satellite,
      manifest,
      kind: "read",
      targetId: screen.id,
      title: screen.title,
      description: `Read the "${screen.title}" screen from ${satellite.displayName}.${
        screen.description === undefined ? "" : ` ${screen.description}`
      }`,
      audience: screen.audience,
      properties: Object.fromEntries(
        (screen.params ?? []).map((param) => [
          param.name,
          // A screen param travels in a query string, so it is a string and
          // nothing in the schema pretends otherwise.
          { type: "string" as const, ...(param.description === undefined ? {} : { description: param.description }) },
        ]),
      ),
      required: (screen.params ?? []).filter((param) => param.required).map((param) => param.name),
    });
    if ("reason" in tool) skipped.push({ toolId: screen.id, reason: tool.reason });
    else tools.push(tool);
  }

  for (const action of manifest.actions) {
    if (action.params === undefined) {
      // Not silence: an agent that cannot see the shape would guess field names
      // at a write endpoint, which is the worst outcome available here.
      skipped.push({
        toolId: action.id,
        reason: "action declares no parameters, so no agent can call it",
      });
      continue;
    }

    const title = action.title ?? action.id;
    const tool = build({
      satellite,
      manifest,
      kind: "write",
      targetId: action.id,
      title,
      description: `${title} in ${satellite.displayName}.${
        action.description === undefined ? "" : ` ${action.description}`
      }`,
      audience: action.audience,
      properties: Object.fromEntries(
        action.params.map((param) => [
          param.name,
          param.type === "string[]"
            ? {
                type: "array" as const,
                items: {
                  type: "string" as const,
                  ...(param.enum === undefined ? {} : { enum: param.enum }),
                },
                ...(param.description === undefined ? {} : { description: param.description }),
              }
            : {
                type: param.type,
                ...(param.description === undefined ? {} : { description: param.description }),
                ...(param.enum === undefined ? {} : { enum: param.enum }),
              },
        ]),
      ),
      required: action.params.filter((param) => param.required).map((param) => param.name),
    });
    if ("reason" in tool) skipped.push({ toolId: action.id, reason: tool.reason });
    else tools.push(tool);
  }

  // Two ids can project onto one tool name, and both are then dropped: an agent
  // reaching a tool the registry never said it could is worse than a tool being
  // missing. Done over the finished list so a screen and an action cannot
  // collide with each other unnoticed either.
  // `unprojectable` is deliberately not read: `build` already refused every id
  // that has no name, with a reason, so nothing here can be missing one.
  const { index, collisions } = indexToolNames(
    tools.map((tool) => ({ satelliteId: tool.satelliteId, toolId: tool.targetId })),
  );

  const dropped = new Set<string>();
  for (const collision of collisions) {
    for (const ref of collision.refs) {
      dropped.add(ref.toolId);
      skipped.push({
        toolId: ref.toolId,
        reason: `tool name "${collision.name}" is claimed by ${collision.refs.length} ids at once`,
      });
    }
  }

  return {
    tools: tools.filter((tool) => index.has(tool.name) && !dropped.has(tool.targetId)),
    skipped,
  };
}

interface BuildInput {
  readonly satellite: Satellite;
  readonly manifest: Manifest;
  readonly kind: ToolKind;
  readonly targetId: string;
  readonly title: string;
  readonly description: string;
  readonly audience: readonly Audience[];
  readonly properties: Record<string, JsonPropertySchema>;
  readonly required: string[];
}

function build(input: BuildInput): ToolDescriptor | { reason: string } {
  const name = projectToolName(input.satellite.id, input.targetId);
  if (name === undefined) {
    return { reason: `id is too long to project into an MCP tool name` };
  }

  const policy = toolPolicy(input.satellite, input.targetId);
  const isRead = input.kind === "read";

  // Every enclosing layer, narrowed and accumulated by one function rather than
  // restated here. The satellite's entry is a layer because the hub's screen
  // and action routes gate on it *before* they look at what a screen declares —
  // skipping it once offered an internal-only satellite's externally-declared
  // screen to an external principal. The registry's tool policy is a layer
  // because its silence means internal, so listing a tool at all pins it there
  // unless the entry widens it.
  const { audience, rbacScopes } = combine([
    satelliteLayer(input.satellite),
    { audience: input.audience },
    policy,
  ]);

  if (audience.length === 0) {
    return { reason: "registry and manifest agree on no audience for this tool" };
  }

  return {
    name,
    satelliteId: input.satellite.id,
    kind: input.kind,
    targetId: input.targetId,
    title: input.title,
    description: input.description,
    inputSchema: {
      type: "object",
      properties: input.properties,
      required: input.required,
      additionalProperties: false,
    },
    audience,
    rbacScopes,
    requiresConfirmation: policy?.requiresConfirmation ?? !isRead,
    agentVisible: policy?.agentVisible ?? isRead,
  };
}
