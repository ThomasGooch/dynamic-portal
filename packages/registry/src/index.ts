/**
 * The satellite registry — which solutions exist, who may see them, and how
 * patient to be with each.
 *
 * Deliberately a package rather than hub-internal: the hub, the public API
 * façade and the MCP gateway all need to answer "who may see this satellite",
 * and they must answer it identically.
 */

export { UnresolvedVariableError, expandEnv } from "./expand";

export {
  RegistryError,
  SatelliteSchema,
  findSatellite,
  loadRegistry,
  resolveNav,
  visibleSatellites,
  type Audience,
  type NavItem,
  type NavSection,
  type Registry,
  type Satellite,
} from "./registry";

export {
  combine,
  entitle,
  satelliteLayer,
  toolPolicy,
  type Entitlement,
  type EntitlementLayer,
} from "./entitlement";

export {
  CircuitBreaker,
  type BreakerState,
  type CircuitBreakerOptions,
} from "./breaker";

export {
  SatelliteClient,
  type Failure,
  type HealthReport,
  type HealthStatus,
  type Result,
  type SatelliteClientOptions,
} from "./client";
