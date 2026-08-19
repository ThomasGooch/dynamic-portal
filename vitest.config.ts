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
/**
 * JSX has to be transformed for the tests, and by exactly one thing.
 *
 * The hub's tsconfig sets `jsx: "preserve"` because Next owns that transform.
 * Vitest does not run through Next, so JSX reaches the parser untransformed and
 * fails as a *syntax error at import time* — which presents as a broken suite
 * rather than a failing test.
 *
 * Two details cost an hour each if you do not know them. Vite 8 transforms with
 * oxc, so the `esbuild` option is accepted, warned about, and ignored. And an
 * inline Vitest project does not inherit the root config, so this belongs on
 * each project rather than at the top level.
 */
const oxc = { jsx: { runtime: "automatic", importSource: "react" } } as const;

/**
 * The hub's own `@/` alias, which Next resolves from `apps/hub/tsconfig.json`
 * and Vitest otherwise does not.
 *
 * Without it a test cannot import a hub route at all — the route's own
 * `@/lib/http` import fails to resolve — which is why the action route had no
 * test of any kind. The trailing slash matters: keyed on `@` alone it would
 * also swallow `@portal/...`.
 */
const alias = { "@/": new URL("./apps/hub/src/", import.meta.url).pathname };

export default defineConfig({
  test: {
    projects: [
      {
        oxc,
        resolve: { alias },
        test: {
          name: "unit",
          include: ["{packages,apps}/*/src/**/*.test.{ts,tsx}"],
          exclude: ["**/*.integration.test.*", "**/node_modules/**"],
          environment: "node",
        },
      },
      {
        oxc,
        resolve: { alias },
        test: {
          name: "integration",
          include: ["{packages,apps}/*/src/**/*.integration.test.{ts,tsx}"],
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
