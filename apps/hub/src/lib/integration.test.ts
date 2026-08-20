import { describe, expect, it } from "vitest";
import { loadRegistry } from "@portal/registry";
import { agentReach, REACH_LABEL } from "./integration";

/**
 * The tag is a claim about the deployment, so it has to come from the file the
 * deployment is configured by.
 */

const entry = (yaml: string) => loadRegistry(yaml)[0]!;

const base = `- id: orders
  displayName: Order Management
  baseUrl: http://localhost:4001
  owner: fulfillment-team
  rbacScopes: [orders.read]
`;

describe("how the agent reaches a solution", () => {
  it("is mcp when the registry gives it an mcpUrl", () => {
    expect(agentReach(entry(`${base}  mcpUrl: http://localhost:4001/mcp\n`))).toBe("mcp");
  });

  it("is shim when the registry does not", () => {
    // The common case, and the one the portal is designed around: agent-reachable
    // with no second server to run.
    expect(agentReach(entry(base))).toBe("shim");
  });

  it("cannot be claimed by a satellite the registry did not grant it to", () => {
    // A manifest declares `mcpUrl` too, and nothing in the hub reads that one.
    // If this tag did, a satellite could advertise an integration the platform
    // team never approved by editing a file it owns — and the hub would still
    // be shimming it, so the tag would be wrong as well as unearned.
    const satellite = entry(base);
    const pretending = { ...satellite, manifestMcpUrl: "http://localhost:4001/mcp" };

    expect(agentReach(pretending)).toBe("shim");
  });

  it("says what a reader came for", () => {
    expect(REACH_LABEL.mcp).toBe("MCP");
    expect(REACH_LABEL.shim).toBe("Non-MCP");
  });
});

describe("the committed registry", () => {
  it("still has more shimmed solutions than MCP ones", async () => {
    const { readFileSync } = await import("node:fs");
    const registry = loadRegistry(
      readFileSync(new URL("../../../../config/satellites.yaml", import.meta.url), "utf8"),
      {},
    );

    const mcp = registry.filter((s) => agentReach(s) === "mcp");
    const shim = registry.filter((s) => agentReach(s) === "shim");

    // Not decoration. "Most satellites should not host one" is the claim the
    // shim exists to make good on, and a demo where every solution had its own
    // MCP server would quietly stop making it — while still passing every other
    // test in this repository.
    expect(shim.length).toBeGreaterThan(mcp.length);
    expect(mcp.length).toBeGreaterThan(0);
  });
});
