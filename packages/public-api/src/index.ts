/**
 * The brokered external surface.
 *
 * PLAN.md's answer to "external clients, programmatically": partners never
 * touch PUP, the component catalog, or MCP. They see services, resources and
 * operations under names the registry assigns, and the internal vocabulary
 * stays free to change because nothing outside the organization depends on it.
 *
 * Versioned apart from everything it projects, permanently. This contract has
 * an obligation to people we cannot deploy for.
 */

export {
  PUBLIC_API_VERSION,
  buildCatalog,
  resolveOperation,
  resolveResource,
  type CatalogEntry,
  type PublicCatalog,
  type PublicOperation,
  type PublicOperationParam,
  type PublicResource,
  type PublicResourceParam,
  type PublicService,
  type ResolvedOperation,
  type ResolvedResource,
} from "./catalog";

export {
  checkOperationParams,
  checkResourceParams,
  projectOperation,
  projectResource,
  type ArgumentCheck,
  type PublicCollection,
  type PublicColumn,
  type PublicOperationResponse,
  type PublicResourceResponse,
} from "./respond";
