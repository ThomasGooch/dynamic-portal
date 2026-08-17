import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The operator-facing documents have to name every setting a process refuses to
 * run without.
 *
 * This exists because they twice did not. `PORTAL_AUDIT_KEY` and
 * `PORTAL_AUDIT_LOG` were added to the code in one branch and deleted from
 * `.env.example` in another cut before it; the second merged last, so main
 * shipped a template that told operators the two settings the hub requires
 * deliberately did not exist. Nothing in the repository noticed, because
 * nothing in the repository read `.env.example`. A correctness claim enforced
 * by asking reviewers to merge in a particular order is not a control; this is.
 *
 * In the integration tier because it reads files, and `vitest.config.ts` defines
 * the unit tier as touching no filesystem.
 */

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const read = (name: string) => readFileSync(join(repoRoot, name), "utf8");

/**
 * Every variable whose absence stops a process serving, and where it bites.
 *
 * Adding one here without documenting it fails this suite, which is the point:
 * the failure lands on whoever introduced the requirement rather than on the
 * operator who trusted the template.
 */
const MANDATORY = ["PORTAL_PRINCIPAL_SECRET", "PORTAL_AUDIT_KEY", "PORTAL_AUDIT_LOG"] as const;

describe(".env.example", () => {
  const example = read(".env.example");

  it.each(MANDATORY)("declares %s uncommented, so copying the file gets you the name", (name) => {
    // Commented out reads as optional. An operator copies this file and fills
    // in what is assigned; a `#` in front is how a required setting goes
    // missing without anyone deleting a line.
    expect(example).toMatch(new RegExp(`^${name}=`, "m"));
  });

  it.each(MANDATORY)("says %s is mandatory rather than leaving it to be inferred", (name) => {
    const block = example.split(/\n\s*\n/).find((paragraph) => paragraph.includes(`${name}=`));
    expect(block, `no block declares ${name}`).toBeDefined();
    expect(block).toMatch(/mandatory|required|refuse/i);
  });
});

describe("README", () => {
  const readme = read("README.md");

  it.each(MANDATORY)("documents %s in the configuration table", (name) => {
    // The template is what an operator copies; the README is what they read
    // first. Both drifted last time, and only one of them was noticed.
    expect(readme).toContain(`\`${name}\``);
  });
});
