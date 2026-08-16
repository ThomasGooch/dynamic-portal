/**
 * The agent-facing projection of the same declarations the screens render.
 *
 * Nothing here is a second description of a solution. A screen becomes a read
 * tool and an action becomes a write tool, from the manifest the satellite
 * already publishes — which is why "most satellites, not all" have MCP servers
 * and every satellite is still agent-reachable.
 *
 * The gateway owns the parts a satellite must not: namespacing, the entitlement
 * check, the confirmation gate on writes, what leaves in a tool result, and the
 * audit record. If MCP is superseded, this package is replaced and no satellite
 * changes.
 */

export {
  MAX_TOOL_NAME_LENGTH,
  indexToolNames,
  projectToolName,
  type ToolNameCollision,
  type ToolNameIndex,
  type ToolRef,
} from "./names";

export {
  shimTools,
  type JsonObjectSchema,
  type JsonPropertySchema,
  type ShimResult,
  type SkippedTool,
  type ToolDescriptor,
  type ToolKind,
} from "./shim";

export {
  buildSurface,
  type SurfaceEntry,
  type SurfaceSkip,
  type ToolSurface,
} from "./surface";

export {
  MAX_EXTRACTED_ROWS,
  extractData,
  type ExtractedChart,
  type ExtractedColumn,
  type ExtractedData,
  type ExtractedFact,
  type ExtractedStat,
  type ExtractedTable,
} from "./extract";

export {
  invokeTool,
  type InvokeDeps,
  type ToolFailureReason,
  type ToolResult,
  type ToolTransport,
} from "./invoke";
