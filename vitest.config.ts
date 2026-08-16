import { defineConfig } from "vitest/config";

/**
 * Three test tiers, defined by what they are allowed to touch.
 *
 *   unit         Pure logic. No sockets, no filesystem, no clock. Schemas,
 *                validators, the tree-shape adapters, version policy. These run
 *                on every save and must stay in the low hundreds of ms.
 *
 *   integration  Real HTTP across a real process boundary, no browser. A hub
 *                proxy talking to a satellite; the conformance kit talking to a
 *                running service. This is the tier that proves a satellite
 *                enforces its own tenant scoping when called directly — the
 *                single most important claim in the security model, and one a
 *                unit test structurally cannot make.
 *
 *   e2e          A browser driving the real hub against real satellites.
 *                Playwright, configured separately in playwright.config.ts.
 *                The verification list in PLAN.md is already an e2e plan:
 *                deep linking, form round-trip, blast radius, trust boundary.
 *
 * The tiers are separated by filename, not directory, so a test lives next to
 * the code it covers regardless of how much of the stack it exercises.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["{packages,apps}/*/src/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts", "**/node_modules/**"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["{packages,apps}/*/src/**/*.integration.test.ts"],
          exclude: ["**/node_modules/**"],
          environment: "node",
          // Real servers bind real ports; give them room without hiding a hang.
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // Ports are a shared resource — integration suites run serially.
          fileParallelism: false,
        },
      },
    ],
  },
});
