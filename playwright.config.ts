import { defineConfig } from "@playwright/test";

/**
 * The e2e tier: tests that exercise the running stack rather than an in-process
 * server. Start it first with `pnpm up`.
 *
 * Today these run against the satellites over HTTP. Once the hub lands they gain
 * browser specs, and the verification list in PLAN.md becomes the spec list
 * almost line for line — deep linking, form round-trip, blast radius, trust
 * boundary. Browsers are not installed until there is a browser test to run
 * (`pnpm exec playwright install chromium`), so this tier stays fast meanwhile.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env["PORTAL_HUB_URL"] ?? "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
});
