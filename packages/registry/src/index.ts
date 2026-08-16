/**
 * The satellite registry — which solutions exist, who may see them, and how
 * patient to be with each.
 *
 * Deliberately a package rather than hub-internal: the hub, the public API
 * façade and the MCP gateway all need to answer "who may see this satellite",
 * and they must answer it identically.
 */

export {
  RegistryError,
  SatelliteSchema,
  findSatellite,
  loadRegistry,
  resolveNav,
  visibleSatellites,
  type NavItem,
  type NavSection,
  type Registry,
  type Satellite,
} from "./registry.js";

export {
  CircuitBreaker,
  type BreakerState,
  type CircuitBreakerOptions,
} from "./breaker.js";
