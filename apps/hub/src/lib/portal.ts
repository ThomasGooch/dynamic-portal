import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SatelliteClient,
  loadRegistry,
  type Registry,
  type Satellite,
} from "@portal/registry";

/**
 * The hub's view of the world: the registry, and one client per satellite.
 *
 * Clients are created once and reused, because each owns a circuit breaker.
 * A breaker rebuilt per request would forget every failure it had just seen,
 * which is the same as not having one — the state *is* the memory.
 */

const CONFIG_PATH =
  process.env["PORTAL_REGISTRY_PATH"] ?? join(process.cwd(), "..", "..", "config", "satellites.yaml");

function requiredSecret(): string {
  const secret = process.env["PORTAL_PRINCIPAL_SECRET"];
  if (!secret) {
    // Failing at startup beats defaulting to a well-known secret, which would
    // let every satellite accept identities the hub never actually verified.
    throw new Error("PORTAL_PRINCIPAL_SECRET is required");
  }
  return secret;
}

interface Portal {
  readonly registry: Registry;
  readonly clientFor: (satellite: Satellite) => SatelliteClient;
}

let portal: Portal | undefined;

export function getPortal(): Portal {
  if (portal !== undefined) return portal;

  // turbopackIgnore: the registry is deployment config read at runtime — a
  // mounted file or a path given by the environment — not an asset to inline at
  // build time. Without this the bundler tries to resolve it statically and
  // fails the build.
  const registry = loadRegistry(readFileSync(/* turbopackIgnore: true */ CONFIG_PATH, "utf8"));
  const secret = requiredSecret();
  const clients = new Map<string, SatelliteClient>();

  portal = {
    registry,
    clientFor(satellite) {
      let client = clients.get(satellite.id);
      if (client === undefined) {
        client = new SatelliteClient({ satellite, principalSecret: secret });
        clients.set(satellite.id, client);
      }
      return client;
    },
  };
  return portal;
}

/** Test seam: drops the memoised portal so a suite can change the config. */
export function resetPortal(): void {
  portal = undefined;
}
