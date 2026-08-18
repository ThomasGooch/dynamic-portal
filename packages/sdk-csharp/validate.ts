import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionResponseSchema,
  ManifestSchema,
  ScreenResponseSchema,
  UiNodeSchema,
} from "@portal/protocol";
import { validateNested } from "@portal/catalog";

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

  // `dotnet run` may print build noise before the payload; the document starts
  // at the first brace.
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

if (failures > 0) {
  process.stderr.write(`\n${failures} envelope(s) the hub would refuse.\n`);
  process.exit(1);
}
process.stdout.write("\n  every envelope the C# SDK builds is one the hub accepts\n");
