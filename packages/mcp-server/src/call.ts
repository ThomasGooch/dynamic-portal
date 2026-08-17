import type { Principal } from "@portal/identity";
import { invokeTool, type InvokeDeps, type ToolSurface } from "@portal/mcp-gateway";
import { isListed } from "./tools";

/**
 * Running one tool for an MCP host.
 *
 * A thin shell over the gateway, and deliberately thin: entitlement, argument
 * checking, the confirmation gate and the audit record all happen there, once,
 * for every caller. What this adds is the MCP result shape and one refusal the
 * gateway has no opinion about — a tool the outward surface does not list must
 * not be callable by name.
 */

export interface McpTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface McpCallResult {
  readonly content: readonly McpTextContent[];
  readonly isError?: boolean;
}

const text = (value: string, isError = false): McpCallResult => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError: true } : {}),
});

export async function callMcpTool(
  surface: ToolSurface,
  name: string,
  args: Readonly<Record<string, unknown>>,
  principal: Principal,
  deps: Omit<InvokeDeps, "confirmed">,
): Promise<McpCallResult> {
  // Listed is not the same as present on the surface. A governed write is on
  // the surface and off the listing, and calling it by name would be a way
  // around the very gate the listing exists to respect. Asked of the surface's
  // own index rather than by scanning a freshly built listing: same answer, one
  // lookup, and no second copy of every descriptor per call.
  const tool = surface.byName.get(name);
  if (tool === undefined) {
    return text(`No tool named "${name}" is available to this account.`, true);
  }
  if (!isListed(tool)) {
    return text(
      `"${tool.title}" changes data and has to be approved by a person in the portal. ` +
        `Ask the user to do it there; it cannot be run from here.`,
      true,
    );
  }

  const result = await invokeTool(surface, name, args, principal, {
    ...deps,
    // Never true from here. Nothing an MCP host can send constitutes a person
    // having been shown what is about to happen.
    confirmed: false,
  });

  if (!result.ok) return text(result.message, true);

  if (result.kind === "read") {
    // JSON in a text block rather than a structured field: every host renders
    // text, and the data is already the shape the gateway chose to expose.
    return text(JSON.stringify(result.data, null, 2));
  }

  const parts = [`Outcome: ${result.outcome}`];
  if (result.message !== undefined) parts.push(result.message);
  if (result.fieldErrors !== undefined) {
    for (const [field, message] of Object.entries(result.fieldErrors)) {
      parts.push(`${field}: ${message}`);
    }
  }
  return text(parts.join("\n"), result.outcome !== "ok");
}
