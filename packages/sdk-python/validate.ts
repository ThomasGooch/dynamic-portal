import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionResponseSchema,
  ManifestSchema,
  ScreenResponseSchema,
  UiNodeSchema,
} from "@portal/protocol";
import { COMPONENT_NAMES, validateNested } from "@portal/catalog";

/**
 * Does what the Python SDK builds actually satisfy the hub?
 *
 * A pytest process can only check that the SDK produced what the SDK intended.
 * Only the protocol package knows whether that is a response the hub accepts,
 * and nothing in Python can ask it, because the schemas are Zod.
 *
 * That gap shipped a bug: this SDK sent a toast level of `danger` — a
 * component tone the hub refuses — and every Python test passed, because no
 * satellite here ships an action for one to exercise.
 *
 * Exporting JSON Schema for Python to validate against was the obvious
 * alternative and is a worse one. The protocol's sharpest rules are Zod
 * refinements — duplicate screen ids, a nav entry naming a screen that does
 * not exist, a screen whose audience is wider than its satellite's — and none
 * of them survive the conversion. A validator that silently drops those is a
 * control that looks present and is not.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Run from the satellite, which is the environment with the SDK installed. */
function probe(): Record<string, unknown> {
  const output = execFileSync(
    "uv",
    ["run", "python", join(here, "probe.py")],
    {
      cwd: join(here, "..", "..", "apps", "satellite-fleet"),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const start = output.indexOf("{");
  if (start === -1) throw new Error(`the probe printed no JSON:\n${output}`);
  return JSON.parse(output.slice(start)) as Record<string, unknown>;
}

const payload = probe();
let failures = 0;

function check(name: string, result: { success: boolean; error?: unknown }): void {
  if (result.success) {
    process.stdout.write(`  ${name}: valid\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  ${name}: REJECTED\n${JSON.stringify(result.error, null, 2)}\n`);
}

/**
 * Checked rather than asserted: a probe that stopped emitting one of these
 * would otherwise fail as a TypeError somewhere below, which is exactly the
 * unhelpful failure the rest of this script takes care not to produce.
 */
function required<T>(key: string, guard: (value: unknown) => value is T): T {
  const value = payload[key];
  if (!guard(value)) {
    process.stderr.write(
      `the probe emitted no usable "${key}". It builds the envelopes this ` +
        "script checks, so a missing one means the check covered less than it reports.\n",
    );
    process.exit(1);
  }
  return value;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const screen = required("screen", (v): v is { ui: unknown } => isObject(v) && "ui" in v);
const actions = required("actions", isObject);

check("manifest", ManifestSchema.safeParse(payload["manifest"]));
check("screen", ScreenResponseSchema.safeParse(screen));
for (const [name, body] of Object.entries(actions)) {
  check(`action.${name}`, ActionResponseSchema.safeParse(body));
}

// Both gates the hub runs, in the order it runs them: the node schema takes
// unknown input and bounds the tree; the catalog knows the vocabulary.
const parsedUi = UiNodeSchema.safeParse(screen.ui);
check("screen.ui as a node tree", parsedUi);
if (parsedUi.success) {
  const catalog = validateNested(parsedUi.data);
  check(
    "screen.ui against the catalog",
    catalog.ok ? { success: true } : { success: false, error: catalog },
  );
}

// An empty `actions` object passes the loop above without checking anything,
// and the summary below would still say every envelope was accepted.
if (Object.keys(actions).length === 0) {
  process.stderr.write("the probe emitted no actions, so no action envelope was checked.\n");
  process.exit(1);
}

// Coverage, enforced rather than reported. Printing a number nobody compares
// is how this script could pass while checking less than it claims: drop a
// component and the count quietly shrinks while the final line still says
// every envelope is accepted. The catalog is the authority on what "every
// component" means.
//
// Checked against what the probe says it *built*, not against the finished
// tree. The enum sweep emits a node per enum value, so a component the probe
// never built still appears in the tree through its own tone/size variants —
// and a tree-shaped check passes while a builder goes uncalled.
const built = required("componentsBuilt", (v): v is string[] =>
  Array.isArray(v) && v.every((name) => typeof name === "string"),
);
const enumNodes = required("enumNodesBuilt", (v): v is number => typeof v === "number");
const children = (screen.ui as { children?: { type: string }[] }).children ?? [];
const covered = new Set(built);
const uncovered = COMPONENT_NAMES.filter((name) => !covered.has(name));
process.stdout.write(
  `  coverage: ${covered.size}/${COMPONENT_NAMES.length} components, ` +
    `${enumNodes} enum values, ${children.length} nodes\n`,
);
if (uncovered.length > 0) {
  failures += 1;
  process.stdout.write(
    `  coverage: INCOMPLETE — the probe never built ${uncovered.join(", ")}\n`,
  );
}
// Every component carries at least one enum prop somewhere in the catalog, so
// a zero here means the sweep resolved no annotations at all — which is how it
// silently swept nothing once already.
if (enumNodes === 0) {
  failures += 1;
  process.stdout.write("  coverage: INCOMPLETE — the enum sweep produced no nodes\n");
}

if (failures > 0) {
  process.stderr.write(`\n${failures} envelope(s) the hub would refuse.\n`);
  process.exit(1);
}
process.stdout.write("\n  every envelope the Python SDK builds is one the hub accepts\n");
