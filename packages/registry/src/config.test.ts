import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Principal } from "@portal/identity";
import { loadRegistry, resolveNav, visibleSatellites } from "./registry.js";

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
    expect(registry.map((s) => s.id).sort()).toEqual(["fleet", "orders"]);
  });

  it("points at the ports docker-compose publishes", () => {
    const ports = Object.fromEntries(
      registry.map((s) => [s.id, new URL(s.baseUrl).port]),
    );
    expect(ports).toEqual({ orders: "4001", fleet: "4002" });
  });

  it("is entirely internal-only, so nothing is externally reachable by accident", () => {
    // If this ever fails, someone widened a satellite's audience — which may be
    // correct, but should be a deliberate, reviewed change rather than a
    // side effect.
    for (const satellite of registry) {
      expect(satellite.audience, `${satellite.id}`).toEqual(["internal"]);
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

  it("shows an external principal nothing at all today", () => {
    expect(visibleSatellites(registry, principal({ audience: "external" }))).toEqual([]);
  });
});
