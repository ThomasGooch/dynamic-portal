import { parse as parseYaml } from "yaml";
import { expandEnv } from "./expand";
import { z } from "zod";
import { AudienceListSchema, isAudienceSubset, type Audience } from "@portal/protocol";
import { authorize, type Principal } from "@portal/identity";

/**
 * Which satellites exist, who may see them, and how patient to be with each.
 *
 * Config-as-code rather than a database: the set of solutions changes on a
 * deploy cadence, not a request cadence, and a file in the repository is
 * reviewable, diffable and revertible in a way a table is not.
 *
 * Lives in `packages/` rather than inside the hub because three consumers need
 * it — the hub, the public API façade, and the MCP gateway — and each must
 * answer "who may see this satellite" the same way.
 */

const IdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:[.\-_][a-z0-9]+)*$/, 'ids are lower-kebab/dot segments, e.g. "orders"');

/**
 * The hub dereferences `baseUrl` on every request, so the scheme is checked
 * rather than assumed. `z.string().url()` is `new URL()` underneath and accepts
 * `javascript:`, `data:` and `file:` — the same hole found in the protocol's
 * `mcpUrl` and the catalog's `Link.href`. Third time, so it is a test before it
 * is a finding.
 */
const HttpUrlSchema = z.string().refine((value) => {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}, "must be an absolute http(s) URL");

const NavSchema = z
  .object({
    section: z.string().min(1).default("Solutions"),
    order: z.number().int().default(100),
  })
  .strict();

const ToolPolicySchema = z
  .object({
    requiresConfirmation: z.boolean().default(false),
    agentVisible: z.boolean().default(true),
    rbacScopes: z.array(z.string().min(1)).default([]),
    audience: AudienceListSchema,
  })
  .strict();

export const SatelliteSchema = z
  .object({
    id: IdSchema,
    displayName: z.string().min(1),
    description: z.string().optional(),
    baseUrl: HttpUrlSchema,
    /** Absent means the hub generates an MCP shim from the PUP manifest. */
    mcpUrl: HttpUrlSchema.optional(),
    owner: z.string().min(1),
    audience: AudienceListSchema,
    nav: NavSchema.default({ section: "Solutions", order: 100 }),
    rbacScopes: z.array(z.string().min(1)).default([]),
    /** A satellite that omits this must not be able to hang the hub. */
    timeoutMs: z.number().int().positive().default(3000),
    // Keyed by IdSchema, not bare strings: a tool id is projected into an MCP
    // tool name, so `"  weird key !!"` must be rejected here rather than
    // discovered by whatever consumes the projection.
    tools: z.record(IdSchema, ToolPolicySchema).default({}),
  })
  .strict()
  .superRefine((satellite, ctx) => {
    // Default-deny has to hold downwards, exactly as ManifestSchema enforces it
    // for screens and actions. Without this, an internal-only satellite could
    // still mark a tool ["external"], and a projection that filters on the
    // tool's own audience — the natural reading — would publish it outside the
    // org.
    for (const [toolId, tool] of Object.entries(satellite.tools)) {
      if (!isAudienceSubset(tool.audience, satellite.audience)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tools", toolId, "audience"],
          message: `tool "${toolId}" is exposed to an audience its satellite is not`,
        });
      }
    }
  });

export type Satellite = z.infer<typeof SatelliteSchema>;
export type Registry = readonly Satellite[];

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

export function loadRegistry(
  source: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Registry {
  // Substitution happens before parsing, so a value may be any YAML scalar
  // rather than only a quoted string. Deliberately outside the try below: an
  // UnresolvedVariableError is not a YAML problem, and relabelling it as one
  // sends an operator looking for a syntax error that is not there.
  const expanded = expandEnv(source, env);

  let raw: unknown;
  try {
    raw = parseYaml(expanded);
  } catch (error) {
    throw new RegistryError(`registry is not valid YAML: ${(error as Error).message}`);
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    // A hub with no satellites is a misconfiguration, not an empty state — it
    // renders an empty shell that looks like everything is broken.
    throw new RegistryError("registry must be a non-empty list of satellites");
  }

  const satellites: Satellite[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    const parsed = SatelliteSchema.safeParse(entry);
    if (!parsed.success) {
      // Index included deliberately: an operator with twenty satellites needs
      // to know which entry is wrong, not merely that one is.
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new RegistryError(`registry entry ${index} is invalid — ${detail}`);
    }
    if (seen.has(parsed.data.id)) {
      throw new RegistryError(
        `registry entry ${index} has a duplicate id "${parsed.data.id}"`,
      );
    }
    seen.add(parsed.data.id);
    satellites.push(parsed.data);
  }

  return satellites;
}

/** Satellites this principal may see at all. */
export function visibleSatellites(registry: Registry, principal: Principal): Satellite[] {
  return registry.filter(
    (satellite) =>
      authorize(principal, {
        audience: satellite.audience,
        rbacScopes: satellite.rbacScopes,
      }).allowed,
  );
}

export interface NavItem {
  readonly satelliteId: string;
  readonly label: string;
  readonly order: number;
}

export interface NavSection {
  readonly section: string;
  readonly items: readonly NavItem[];
}

/**
 * Navigation for one principal.
 *
 * Filtering happens here rather than in the shell so a satellite a principal
 * cannot reach never reaches the browser at all. An empty section is dropped:
 * a heading with nothing under it tells a user something exists that they
 * cannot see, which is both confusing and a small disclosure.
 */
export function resolveNav(registry: Registry, principal: Principal): NavSection[] {
  const bySection = new Map<string, NavItem[]>();

  for (const satellite of visibleSatellites(registry, principal)) {
    const items = bySection.get(satellite.nav.section) ?? [];
    items.push({
      satelliteId: satellite.id,
      label: satellite.displayName,
      order: satellite.nav.order,
    });
    bySection.set(satellite.nav.section, items);
  }

  return [...bySection.entries()]
    .map(([section, items]) => ({
      section,
      items: items.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => a.section.localeCompare(b.section));
}

export function findSatellite(registry: Registry, id: string): Satellite | undefined {
  return registry.find((satellite) => satellite.id === id);
}

export type { Audience };
