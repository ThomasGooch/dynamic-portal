import type { Principal } from "@portal/identity";
import type { ActionDescriptor, Manifest, ScreenDescriptor } from "@portal/protocol";
import {
  entitle,
  satelliteLayer,
  toolPolicy,
  type EntitlementLayer,
  type Satellite,
} from "@portal/registry";

/**
 * The brokered external surface.
 *
 * PUP and the component catalog are internal contracts. Everything an external
 * client touches passes through this file first, and that indirection is the
 * point: the internal vocabulary stays evolvable by fiat precisely because no
 * partner depends on it. Publishing PUP would freeze it permanently, which
 * PLAN.md names as the mistake to avoid.
 *
 * So nothing here is a screen. A screen becomes a *resource* with a public name
 * the registry assigns, and an action becomes an *operation* — and a satellite
 * team renaming `orders.list` changes one line of registry rather than breaking
 * every client.
 *
 * **Two parties have to agree before anything is visible.** The registry names
 * it publicly, and the satellite's own manifest marks it external. Either alone
 * is not enough, which is the default-deny rule applied at the outermost edge
 * where getting it wrong is a disclosure rather than an inconvenience.
 */

/**
 * Versioned apart from `CURRENT_PROTOCOL_VERSION` and `CATALOG_VERSION`, on
 * purpose and permanently. This one carries a contractual obligation to people
 * outside the organization; those two are ours to change on a Tuesday.
 */
export const PUBLIC_API_VERSION = "1";

export interface PublicResourceParam {
  readonly name: string;
  readonly required: boolean;
  readonly description?: string;
}

export interface PublicOperationParam {
  readonly name: string;
  /** `string[]` mirrors the internal declaration; see `ActionParamSchema`. */
  readonly type: "string" | "number" | "boolean" | "string[]";
  readonly required: boolean;
  readonly description?: string;
  readonly enum?: readonly string[];
}

export interface PublicResource {
  readonly name: string;
  readonly title: string;
  readonly description?: string;
  readonly params: readonly PublicResourceParam[];
}

export interface PublicOperation {
  readonly name: string;
  readonly title: string;
  readonly description?: string;
  readonly params: readonly PublicOperationParam[];
}

export interface PublicService {
  readonly name: string;
  readonly title: string;
  readonly description?: string;
  readonly resources: readonly PublicResource[];
  readonly operations: readonly PublicOperation[];
}

export interface PublicCatalog {
  readonly version: string;
  readonly services: readonly PublicService[];
}

export interface CatalogEntry {
  readonly satellite: Satellite;
  readonly manifest: Manifest;
}

export function buildCatalog(
  entries: readonly CatalogEntry[],
  principal: Principal,
): PublicCatalog {
  const services: PublicService[] = [];

  for (const entry of entries) {
    const projection = entry.satellite.public;
    if (projection === undefined) continue;
    if (!reachable(entry.satellite, principal)) continue;

    const resources = projection.resources
      .map(({ name, screenId }) => {
        const screen = entry.manifest.screens.find((candidate) => candidate.id === screenId);
        return screen !== undefined && publishes(entry.satellite, screen, principal)
          ? describeResource(name, screen)
          : undefined;
      })
      .filter((resource): resource is PublicResource => resource !== undefined);

    const operations = projection.operations
      .map(({ name, actionId }) => {
        const action = entry.manifest.actions.find((candidate) => candidate.id === actionId);
        return action !== undefined && offered(entry.satellite, action, principal)
          ? describeOperation(name, action)
          : undefined;
      })
      .filter((operation): operation is PublicOperation => operation !== undefined);

    // A service with nothing in it is noise in a listing and a url that answers
    // 404 on everything below it.
    if (resources.length === 0 && operations.length === 0) continue;

    services.push({
      name: projection.service,
      title: entry.satellite.displayName,
      ...(entry.satellite.description === undefined
        ? {}
        : { description: entry.satellite.description }),
      resources,
      operations,
    });
  }

  return { version: PUBLIC_API_VERSION, services };
}

export interface ResolvedResource {
  readonly satelliteId: string;
  readonly screenId: string;
  readonly params: readonly PublicResourceParam[];
}

export interface ResolvedOperation {
  readonly satelliteId: string;
  readonly actionId: string;
  readonly params: readonly PublicOperationParam[];
}

/**
 * Resolution runs through the same projection the listing does, so a client
 * cannot reach by url what it could not see in the catalog. Sharing the filter
 * rather than restating it is the whole reason these live in one file.
 */
export function resolveResource(
  entries: readonly CatalogEntry[],
  principal: Principal,
  service: string,
  resource: string,
): ResolvedResource | undefined {
  for (const entry of entries) {
    if (entry.satellite.public?.service !== service) continue;
    if (!reachable(entry.satellite, principal)) continue;

    const mapping = entry.satellite.public.resources.find((item) => item.name === resource);
    if (mapping === undefined) continue;

    const screen = entry.manifest.screens.find((candidate) => candidate.id === mapping.screenId);
    if (screen === undefined || !publishes(entry.satellite, screen, principal)) continue;

    return {
      satelliteId: entry.satellite.id,
      screenId: screen.id,
      params: describeResource(resource, screen).params,
    };
  }
  return undefined;
}

export function resolveOperation(
  entries: readonly CatalogEntry[],
  principal: Principal,
  service: string,
  operation: string,
): ResolvedOperation | undefined {
  for (const entry of entries) {
    if (entry.satellite.public?.service !== service) continue;
    if (!reachable(entry.satellite, principal)) continue;

    const mapping = entry.satellite.public.operations.find((item) => item.name === operation);
    if (mapping === undefined) continue;

    const action = entry.manifest.actions.find((candidate) => candidate.id === mapping.actionId);
    if (action === undefined || !offered(entry.satellite, action, principal)) continue;

    return {
      satelliteId: entry.satellite.id,
      actionId: action.id,
      params: describeOperation(operation, action).params,
    };
  }
  return undefined;
}

/**
 * Reachable *and* published, in one place.
 *
 * The façade adds one rule to the shared entitlement: whatever survives the
 * narrowing must still include `external`. That is what makes it a façade — an
 * internal caller here sees the public API, not everything they are entitled
 * to. The surface is defined by what it projects, not by who is asking.
 */
function offeredTo(
  principal: Principal,
  layers: readonly (EntitlementLayer | undefined)[],
): boolean {
  const decision = entitle(principal, layers);
  return decision.allowed && decision.audience.includes("external");
}

const reachable = (satellite: Satellite, principal: Principal): boolean =>
  offeredTo(principal, [satelliteLayer(satellite)]);

/**
 * The registry's tool policy is a layer here exactly as it is in the gateway.
 *
 * It governs reads as well as writes: `shimTools` narrows a *screen*'s tool by
 * its policy too, so a façade that skipped it would publish externally a screen
 * the governance file had pinned to internal — the same two-projections-
 * disagree bug, one declaration further along.
 */
const publishes = (
  satellite: Satellite,
  screen: ScreenDescriptor,
  principal: Principal,
): boolean =>
  offeredTo(principal, [
    satelliteLayer(satellite),
    { audience: screen.audience },
    toolPolicy(satellite, screen.id),
  ]);

/**
 * Everything a screen needs, plus the one thing a *write* does.
 *
 * An action that declares no parameters is not offered at all, for the same
 * reason the MCP gateway skips one — and for a sharper reason here: a
 * parameterless projection accepts only `{}`, so publishing it would offer a
 * partner a write they can never send the fields for.
 */
function offered(
  satellite: Satellite,
  action: ActionDescriptor,
  principal: Principal,
): boolean {
  if (action.params === undefined) return false;
  return offeredTo(principal, [
    satelliteLayer(satellite),
    { audience: action.audience },
    toolPolicy(satellite, action.id),
  ]);
}

function describeResource(name: string, screen: ScreenDescriptor): PublicResource {
  return {
    name,
    title: screen.title,
    ...(screen.description === undefined ? {} : { description: screen.description }),
    params: (screen.params ?? []).map((param) => ({
      name: param.name,
      required: param.required,
      ...(param.description === undefined ? {} : { description: param.description }),
    })),
  };
}

function describeOperation(name: string, action: ActionDescriptor): PublicOperation {
  return {
    name,
    title: action.title ?? name,
    ...(action.description === undefined ? {} : { description: action.description }),
    params: (action.params ?? []).map((param) => ({
      name: param.name,
      type: param.type,
      required: param.required,
      ...(param.description === undefined ? {} : { description: param.description }),
      ...(param.enum === undefined ? {} : { enum: param.enum }),
    })),
  };
}
