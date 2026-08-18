import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionResponseSchema,
  ManifestSchema,
  ScreenResponseSchema,
  UiNodeSchema,
} from "@portal/protocol";
import { COMPONENTS, COMPONENT_NAMES, validateNested } from "@portal/catalog";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { UiNode } from "@portal/protocol";

/**
 * Does what the C# SDK builds actually satisfy the hub?
 *
 * A C# test can only check that the SDK produced what the SDK intended. Only
 * the protocol package knows whether that is a response the hub accepts, and
 * nothing in a .NET test project can ask it. The Python SDK shipped an
 * envelope the hub rejected outright — a toast level of `danger`, which is a
 * component tone — for exactly that reason: nothing crossed the boundary.
 *
 * So the probe builds one of everything, prints it, and this validates the
 * result against the same schemas the hub enforces at runtime. It is the only
 * check here that could have caught that bug.
 *
 * Runs .NET through Docker rather than requiring a host toolchain, which is
 * how the rest of this repository is built and tested.
 */

const root = dirname(fileURLToPath(import.meta.url));

/** True when a .NET SDK is on PATH, so CI does not pay for Docker it has no need of. */
function hasHostDotnet(): boolean {
  try {
    execFileSync("dotnet", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const DOTNET_ARGS = ["run", "-v", "q", "--nologo", "--project", "Portal.Sdk.Probe"];

function probe(): Record<string, unknown> {
  const env = { DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" };
  const output = hasHostDotnet()
    ? execFileSync("dotnet", DOTNET_ARGS, {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...env },
      })
    : execFileSync(
        "docker",
        [
          "run", "--rm",
          "-v", `${root}:/src`,
          "-w", "/src",
          ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
          "mcr.microsoft.com/dotnet/sdk:9.0",
          "dotnet", ...DOTNET_ARGS,
        ],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );

  // `dotnet run` may print build noise before the payload. The probe writes the
  // document with one `Console.WriteLine`, and the serialiser does not indent,
  // so it is exactly the last line beginning with `{` — whereas the *first* `{`
  // anywhere in the output belongs to whichever MSBuild or NuGet line happened
  // to mention one, and takes the parse down with it.
  const line = output
    .split("\n")
    .map((candidate) => candidate.trim())
    .reverse()
    .find((candidate) => candidate.startsWith("{"));
  if (line === undefined) throw new Error(`the probe printed no JSON:\n${output}`);
  return JSON.parse(line) as Record<string, unknown>;
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

const screen = payload["screen"] as { ui: unknown };
const actions = payload["actions"] as Record<string, unknown>;

check("manifest", ManifestSchema.safeParse(payload["manifest"]));
check("screen", ScreenResponseSchema.safeParse(screen));
for (const [name, body] of Object.entries(actions)) {
  check(`action.${name}`, ActionResponseSchema.safeParse(body));
}

/**
 * Both steps the hub runs, in the order it runs them.
 *
 * `UiNodeSchema` first because it takes unknown input and bounds the tree
 * depth; `validateNested` second because it takes a parsed node and is what
 * knows the component vocabulary. Skipping the first would mean type-asserting
 * exactly the value being checked.
 */
const parsedUi = UiNodeSchema.safeParse(screen.ui);
check("screen.ui as a node tree", parsedUi);
if (parsedUi.success) {
  const ui = validateNested(parsedUi.data);
  check("screen.ui against the catalog", ui.ok ? { success: true } : { success: false, error: ui });
}

/**
 * Is the probe still building one of everything?
 *
 * Valid is not the same as covered. Every check above passes on a probe that
 * builds three components and one envelope, which is what this check used to
 * be, and a wrong enum string — the bug the whole exercise exists to catch —
 * only surfaces for a value something actually sends. So the coverage the
 * comments claim is measured rather than asserted: a component added to the
 * catalog, or an enum value never exercised, fails here until the probe
 * catches up.
 */
function walk(node: UiNode, visit: (node: UiNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

const seenProps = new Map<string, Map<string, Set<unknown>>>();
if (parsedUi.success) {
  walk(parsedUi.data, (node) => {
    let byProp = seenProps.get(node.type);
    if (byProp === undefined) {
      byProp = new Map();
      seenProps.set(node.type, byProp);
    }
    for (const [prop, value] of Object.entries(node.props ?? {})) {
      let values = byProp.get(prop);
      if (values === undefined) {
        values = new Set();
        byProp.set(prop, values);
      }
      values.add(value);
    }
  });
}

const gaps: string[] = [];

/**
 * Enum values are pooled by value set, not by prop.
 *
 * `Tone` is one generated C# enum shared by every prop that uses those six
 * values, so one `ToWire` is what has to be right; demanding all six on each
 * of the five components that take a tone would ask the probe to build thirty
 * nodes to prove one switch statement.
 */
const enumSites = new Map<
  string,
  { readonly values: readonly unknown[]; readonly sites: string[]; readonly seen: Set<unknown> }
>();

for (const name of COMPONENT_NAMES) {
  if (!seenProps.has(name)) {
    gaps.push(`${name} is in the catalog but the probe never builds it`);
  }

  const schema = zodToJsonSchema(COMPONENTS[name], {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as { properties?: Record<string, { enum?: readonly unknown[] }> };

  for (const [prop, definition] of Object.entries(schema.properties ?? {})) {
    if (definition.enum === undefined) continue;
    const key = definition.enum.map(String).join("\u0000");
    let site = enumSites.get(key);
    if (site === undefined) {
      site = { values: definition.enum, sites: [], seen: new Set() };
      enumSites.set(key, site);
    }
    site.sites.push(`${name}.${prop}`);
    for (const value of seenProps.get(name)?.get(prop) ?? []) site.seen.add(value);
  }
}

for (const { values, sites, seen } of enumSites.values()) {
  const where = sites.length === 1 ? sites[0] : `${sites[0]} (and ${sites.length - 1} more)`;
  for (const value of values) {
    if (!seen.has(value)) gaps.push(`${where} never sends ${JSON.stringify(value)}`);
  }
}

check(
  `coverage: all ${COMPONENT_NAMES.length} components and every enum value`,
  gaps.length === 0 ? { success: true } : { success: false, error: gaps },
);

if (failures > 0) {
  process.stderr.write(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}
process.stdout.write("\n  every envelope the C# SDK builds is one the hub accepts\n");
