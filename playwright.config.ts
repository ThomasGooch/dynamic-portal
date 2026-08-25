import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

/**
 * The stack's configuration, as this process sees it.
 *
 * `docker compose` reads `.env`; a `pnpm test:e2e` on the host does not. So a
 * guard like `process.env["PORTAL_MODEL_PROVIDER"] === "ollama"` — which two
 * tests use to skip the one path a local model provably cannot do — never
 * fired, and a local-model run produced two FAILING tests where the author had
 * written two SKIPPED ones. The tests were right; nothing had told them what
 * the stack was running.
 *
 * `loadEnvFile` is Node's own (>= 21.7, and this repo requires 22), so no
 * dependency. It does not overwrite a variable already in the environment,
 * which keeps `PORTAL_MODEL_PROVIDER=... pnpm test:e2e` working as an override.
 */
const envFile = fileURLToPath(new URL(".env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

/**
 * The e2e tier: tests that exercise the running stack rather than an in-process
 * server. Start it first with `pnpm up`.
 *
 * `stack.spec.ts` drives the satellites over HTTP and needs no browser.
 * `portal.spec.ts` drives the hub in one, and is PLAN.md's verification list
 * almost line for line — deep linking, the action envelope, blast radius. It
 * needs `pnpm exec playwright install chromium` once.
 *
 * The blast-radius spec stops and restarts a container through `docker
 * compose`, so this tier expects to own the stack while it runs.
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
