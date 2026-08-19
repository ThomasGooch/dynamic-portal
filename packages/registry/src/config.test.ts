import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { Principal } from "@portal/identity";
import { loadRegistry, resolveNav, visibleSatellites } from "./registry";

/**
 * The registry schema is only useful if it accepts the registry we actually
 * ship. A schema that validates its own fixtures and rejects the real file
 * fails at boot, in the deployed hub, for everyone at once — so the committed
 * config is a test input, not just documentation.
 *
 * Same reasoning as the catalog being checked against the satellites' real
 * screens rather than invented ones.
 */

const CONFIG = fileURLToPath(new URL("../../../config/satellites.yaml", import.meta.url));
const registry = loadRegistry(readFileSync(CONFIG, "utf8"));

const principal = (over: Partial<Principal> = {}): Principal => ({
  sub: "alice@acme.example",
  tenantId: "acme",
  audience: "internal",
  scopes: ["orders.read", "fleet.read"],
  ...over,
});

describe("the committed registry", () => {
  it("loads", () => {
    expect(registry.length).toBeGreaterThan(0);
  });

  it("describes the satellites the compose stack actually runs", () => {
    expect(registry.map((s) => s.id).sort()).toEqual(["depots", "fleet", "orders"]);
  });

  it("points at the ports docker-compose publishes", () => {
    const ports = Object.fromEntries(
      registry.map((s) => [s.id, new URL(s.baseUrl).port]),
    );
    expect(ports).toEqual({ orders: "4001", fleet: "4002", depots: "4003" });
  });

  it("exposes exactly one satellite externally, and names which", () => {
    // If this ever fails, someone widened a satellite's audience. That may well
    // be correct — it was, for `orders` — but it has to be a deliberate change
    // to this list rather than a side effect of editing the file beside it.
    const external = registry
      .filter((satellite) => satellite.audience.includes("external"))
      .map((satellite) => satellite.id);
    expect(external).toEqual(["orders"]);
  });

  it("brokers the external one under public names, never its internal ids", () => {
    const projection = registry.find((satellite) => satellite.id === "orders")?.public;
    expect(projection?.service).toBe("order-management");
    expect(projection?.resources.map((resource) => resource.name)).toEqual(["orders", "order"]);
    // Nothing is offered as an operation yet, deliberately: external clients
    // read their orders and staff approve them.
    expect(projection?.operations).toEqual([]);
  });

  it("gives no satellite a public projection it has not been widened for", () => {
    // The registry schema refuses this outright; asserted here because the
    // committed file is the one that actually ships.
    for (const satellite of registry) {
      if (satellite.public !== undefined) {
        expect(satellite.audience, satellite.id).toContain("external");
      }
    }
  });

  it("gives every satellite an owner, so an unwell one has someone to page", () => {
    for (const satellite of registry) {
      expect(satellite.owner, `${satellite.id}`).not.toBe("");
    }
  });

  it("bounds every satellite's timeout", () => {
    for (const satellite of registry) {
      expect(satellite.timeoutMs, `${satellite.id}`).toBeLessThanOrEqual(10_000);
    }
  });

  it("declares fleet without an MCP endpoint, keeping the shim path exercised", () => {
    const fleet = registry.find((s) => s.id === "fleet");
    expect(fleet?.mcpUrl).toBeUndefined();
  });

  it("marks the approve tool as requiring confirmation", () => {
    // A governed write must not become ungoverned by omission.
    const orders = registry.find((s) => s.id === "orders");
    expect(orders?.tools["orders.approve"]?.requiresConfirmation).toBe(true);
  });

  it("produces a usable nav for an internal principal", () => {
    const nav = resolveNav(registry, principal());
    expect(nav.flatMap((s) => s.items.map((i) => i.satelliteId))).toEqual([
      "orders",
      "fleet",
    ]);
  });

  it("shows an external principal only the satellite that was widened for them", () => {
    const visible = visibleSatellites(registry, principal({ audience: "external" })).map(
      (satellite) => satellite.id,
    );
    expect(visible).toEqual(["orders"]);
  });
});

describe("the workspace itself", () => {
  it("every workspace package's declared entry point exists", async () => {
    // `tsc` compiles a directory, not an entry point, so a package.json whose
    // `main`/`exports` names a file nobody wrote still typechecks clean. The
    // conformance package shipped in exactly that state — every check passing,
    // and unimportable.
    const { readdirSync, existsSync, readFileSync } = await import("node:fs");
    const { join, dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

    /**
     * Every relative path a package.json field names, however deeply nested.
     *
     * `exports` and `bin` are both string-or-map, and `exports` nests further
     * for conditions (`{ ".": { "import": "./dist/index.js" } }`). Reading only
     * the top level would leave the conditional form silently unchecked, which
     * is the same hole in a different shape.
     */
    const paths = (value: unknown): string[] => {
      if (typeof value === "string") return value.startsWith(".") ? [value] : [];
      if (value === null || typeof value !== "object") return [];
      return Object.values(value as Record<string, unknown>).flatMap(paths);
    };

    // Apps declare entry points too, and an app that cannot be imported is the
    // same defect as a package that cannot.
    for (const group of ["packages", "apps"]) {
      const dir = join(root, group);
      for (const name of readdirSync(dir)) {
        const manifestPath = join(dir, name, "package.json");
        if (!existsSync(manifestPath)) continue;

        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;

        for (const field of ["main", "types", "exports", "bin"]) {
          for (const entry of paths(manifest[field])) {
            expect(existsSync(join(dir, name, entry)), `${group}/${name}: ${field} ${entry}`).toBe(
              true,
            );
          }
        }
      }
    }
  });
});


describe("the compose stack can actually demonstrate zero-deploy changes", () => {
  it("mounts the registry into the hub instead of baking it in", () => {
    // The loudest claim this design makes is that adding or renaming a
    // satellite costs no deployment. `COPY . .` puts a copy of the registry in
    // the hub image, so a hub restarted after an edit re-read its own stale
    // copy and nothing changed — the claim was false in the one setup anyone
    // would try it in, and a demo built on it would have failed live.
    // Parsed rather than grepped. A substring match is satisfied by the line
    // appearing anywhere in the file, including inside the comment above it or
    // commented out entirely — which is exactly how this mount would be lost,
    // and the test would have stayed green through it.
    const compose = parse(
      readFileSync(new URL("../../../docker-compose.yml", import.meta.url), "utf8"),
    ) as { services?: Record<string, { volumes?: unknown }> };

    const volumes = compose.services?.["hub"]?.volumes;
    expect(Array.isArray(volumes) ? volumes : []).toContain(
      "./config/satellites.yaml:/repo/config/satellites.yaml:ro",
    );
  });
});
