/**
 * The component vocabulary — one catalog, three shapes, many producers.
 *
 * A satellite emitting a UI tree and a model emitting a UI tree are the same
 * operation against the same vocabulary. This package is what makes that true:
 * both paths validate against the identical prop schemas, so neither can render
 * something the other could not.
 *
 * The catalog is additive-only. Components and props are deprecated, never
 * removed — a five-year-old satellite must still render.
 */

export {
  CATALOG_VERSION,
  COMPONENTS,
  COMPONENT_NAMES,
  isComponentName,
  propsSchemaFor,
  type ComponentName,
} from "./components";

export {
  validateNested,
  type CatalogIssue,
  type CatalogResult,
} from "./nested";

export { FlatSpecSchema, type FlatElement, type FlatSpec } from "./flat";

export {
  GENERATED_ID_PREFIX,
  ReservedNodeIdError,
  flatToKeyed,
  keyedToNested,
  nestedToFlat,
  nestedToKeyed,
  type KeyedElement,
  type KeyedSpec,
} from "./adapters";
