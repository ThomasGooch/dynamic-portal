import type { Satellite } from "@portal/registry";

/**
 * How the agent reaches a solution — which is a property of the deployment, not
 * a measurement of it.
 *
 * Two ways in, and the portal supports both on purpose:
 *
 * **`mcp`** — the satellite hosts its own MCP server and the hub connects to
 * it. Worth doing only for capabilities PUP cannot express: a nested query, an
 * operation with no screen. One of three satellites here qualifies.
 *
 * **`shim`** — the hub derives tools from the PUP manifest the satellite
 * already publishes. No second server, no second surface to secure, and the
 * solution is agent-reachable for free. This is the default and should stay the
 * common case.
 *
 * **Read from the registry, never from the manifest.** Both declare `mcpUrl`,
 * and only the registry's is the one the hub dials — `agent.ts` and the gateway
 * client both read `satellite.mcpUrl`. Tagging from the manifest instead would
 * let a satellite advertise an integration the platform team never granted, by
 * editing a file it owns. That is the same rule the client already enforces for
 * `satelliteId` and `audience`: where the two disagree the registry wins,
 * because it is the file that was reviewed.
 *
 * Deliberately *not* a health check. Whether the MCP server is answering right
 * now is the pill's job; this says which door the portal is configured to use.
 * A satellite whose MCP server is down is still an MCP satellite, and running
 * the two together would make a tag flicker with the network.
 */
export type AgentReach = "mcp" | "shim";

export function agentReach(satellite: Satellite): AgentReach {
  return satellite.mcpUrl === undefined ? "shim" : "mcp";
}

/**
 * What the card says, and what it says when you rest on it.
 *
 * The short label is the word people came for; the long one is the part that
 * matters and that nobody asks about — that a solution without its own server
 * is not a solution the agent cannot see.
 */
export const REACH_LABEL: Record<AgentReach, string> = {
  mcp: "MCP",
  shim: "Non-MCP",
};

export const REACH_DETAIL: Record<AgentReach, string> = {
  mcp: "Hosts its own MCP server. The portal connects to it for capabilities its screens cannot express.",
  shim: "No MCP server. The portal derives the agent's tools from the screens and actions this solution already publishes.",
};
