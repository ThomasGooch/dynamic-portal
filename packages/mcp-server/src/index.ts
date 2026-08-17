/**
 * The hub's own MCP server: one governed endpoint over every solution.
 *
 * The same tool surface the in-hub agent uses, reached over the wire instead of
 * in process — so a staff member's Claude Desktop or IDE agent gets exactly
 * what they would get in the portal, filtered by the same `entitle()` the
 * screens use.
 *
 * An internal contract, deliberately. Partners are brokered through
 * `@portal/public-api`; "outward" here means outside the hub's UI, not outside
 * the organization.
 */

export { mcpTools, serverInstructions, type McpToolAnnotations, type McpToolDescriptor } from "./tools";
export { callMcpTool, type McpCallResult, type McpTextContent } from "./call";
