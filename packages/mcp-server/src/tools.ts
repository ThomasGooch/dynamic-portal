import type { JsonObjectSchema, ToolSurface } from "@portal/mcp-gateway";

/**
 * The hub's own tool surface, as an MCP server sees it.
 *
 * One governed endpoint over every solution: a staff member points Claude
 * Desktop or an IDE agent here and reaches everything they could reach in the
 * portal, filtered by the same `entitle()` the screens use. Nothing is added to
 * the gateway's surface and nothing is filtered out of it beyond the one rule
 * below — a second opinion here would be a second policy engine.
 *
 * **This is an internal contract.** PLAN.md is explicit that partners are
 * brokered through the public API and never touch PUP or MCP; "outward" here
 * means outside the hub's own UI, not outside the organization.
 *
 * **Writes that need confirming are not listed.** The confirmation is a human
 * being shown what is about to happen in a screen the hub renders. An MCP
 * client cannot render that, and handing the decision to a client we do not
 * control would leave the governance nominal — the hub would still be the choke
 * point on paper and not in fact. So they are absent, and the server's
 * instructions say where to perform them instead. A listed tool that always
 * refuses would be worse: it looks like a capability and is a dead end.
 */

export interface McpToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObjectSchema;
  readonly annotations: McpToolAnnotations;
}

export function mcpTools(surface: ToolSurface): McpToolDescriptor[] {
  return surface.tools
    .filter((tool) => !tool.requiresConfirmation)
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        title: tool.title,
        // Stated rather than inferred by the client from the name. A host that
        // auto-approves reads and prompts for writes can only do so if the
        // server says which is which.
        readOnlyHint: tool.kind === "read",
        destructiveHint: tool.kind === "write",
      },
    }));
}

/**
 * What the server tells a host it is, before any tool is called.
 *
 * The absent writes are named here for the same reason the gateway reports what
 * it skipped: a capability that is missing without explanation reads as a bug,
 * and an agent that does not know where approval happens will tell the user it
 * cannot be done.
 */
export function serverInstructions(surface: ToolSurface): string {
  const governed = surface.tools.filter((tool) => tool.requiresConfirmation);

  const lines = [
    "Every solution this account can reach, through one endpoint.",
    "",
    "Tools are named `<solution>__<capability>`. Reads are marked read-only and",
    "return the data behind a screen rather than the screen itself.",
  ];

  if (governed.length > 0) {
    lines.push(
      "",
      "These actions exist but are not callable here, because they change data and",
      "need a person to approve them in the portal, where they can be shown what",
      "is about to happen:",
      ...governed.map((tool) => `  - ${tool.title} (${tool.satelliteId})`),
      "",
      "Direct the user to the portal for those rather than reporting them impossible.",
    );
  }

  return lines.join("\n");
}
