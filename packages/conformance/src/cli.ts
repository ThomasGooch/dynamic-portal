#!/usr/bin/env tsx
import type { Role } from "@portal/protocol";
import { runConformance, type CheckResult } from "./checks";

/**
 * `pnpm conformance http://localhost:4001`
 *
 * Written for someone who has just built a satellite and wants to know whether
 * the hub will accept it. So: one argument, output that fits on a screen, and
 * an exit code a CI job can read.
 */

const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const YELLOW = "\u001b[33m";
const GREY = "\u001b[90m";
const RESET = "\u001b[0m";

const MARK: Record<CheckResult["status"], string> = {
  pass: `${GREEN}✓${RESET}`,
  fail: `${RED}✗${RESET}`,
  warn: `${YELLOW}!${RESET}`,
  skip: `${GREY}–${RESET}`,
};

const USAGE = [
  "usage: pnpm conformance <baseUrl>",
  "",
  "  Checks that a satellite speaks the Portal UI Protocol well enough for the",
  "  hub to render it.",
  "",
  "  PORTAL_PRINCIPAL_SECRET     the secret the satellite verifies principals",
  "                              with, in whatever environment you are testing",
  "  PORTAL_CONFORMANCE_SCOPES   comma-separated scopes the probe should hold.",
  "                              Required scopes live in the hub registry, not",
  "                              the manifest, so this tool cannot find them —",
  "                              a screen refused without them is reported as",
  "                              unchecked rather than broken.",
  "  PORTAL_CONFORMANCE_ROLES    comma-separated org roles the probe should hold.",
  "                              Role gating lives outside the manifest too, so a",
  "                              screen refused for want of a role is likewise",
  "                              reported unchecked rather than broken.",
  "",
  "example: PORTAL_PRINCIPAL_SECRET=dev pnpm conformance http://localhost:4001",
  "",
].join("\n");

async function main(): Promise<number> {
  const [baseUrl] = process.argv.slice(2);

  if (baseUrl === undefined || baseUrl.startsWith("-")) {
    process.stderr.write(USAGE);
    return 2;
  }

  const principalSecret = process.env["PORTAL_PRINCIPAL_SECRET"];
  if (!principalSecret) {
    // Refused rather than defaulted. A well-known secret that happens to work
    // in one environment is how a satellite ends up trusting one everywhere.
    process.stderr.write("PORTAL_PRINCIPAL_SECRET is required.\n");
    return 2;
  }

  const scopes = (process.env["PORTAL_CONFORMANCE_SCOPES"] ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");

  const roles = (process.env["PORTAL_CONFORMANCE_ROLES"] ?? "")
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role !== "") as Role[];

  const report = await runConformance({ baseUrl, principalSecret, scopes, roles });

  process.stdout.write(`\n${report.baseUrl}\n\n`);
  for (const result of report.results) {
    process.stdout.write(`  ${MARK[result.status]} ${result.name} — ${result.detail}\n`);
  }

  const counts = report.results.reduce<Record<string, number>>((totals, result) => {
    totals[result.status] = (totals[result.status] ?? 0) + 1;
    return totals;
  }, {});

  process.stdout.write(
    `\n  ${counts["pass"] ?? 0} passed, ${counts["fail"] ?? 0} failed, ` +
      `${counts["warn"] ?? 0} warnings, ${counts["skip"] ?? 0} not checked\n\n`,
  );

  if ((counts["skip"] ?? 0) > 0) {
    // Printed on every run that has one. A green result which quietly omitted
    // the half that mattered is worse than a red one.
    process.stdout.write(`  Anything marked ${MARK.skip} was not checked, and is not a pass.\n\n`);
  }

  return report.ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`conformance failed to run: ${(error as Error).message}\n`);
    process.exitCode = 2;
  },
);
