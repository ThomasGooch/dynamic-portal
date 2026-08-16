/**
 * Portal UI Protocol (PUP) — the wire contract between satellites and the hub.
 *
 * This package is the organization's durable asset. Renderers, models, MCP
 * versions and UI frameworks are expected to be replaced beneath it; the
 * declarations it describes are not.
 *
 * It deliberately does NOT depend on the component catalog. See `node.ts`.
 */

export {
  CURRENT_PROTOCOL_VERSION,
  MAJOR_SUPPORT_WINDOW,
  PROTOCOL_VERSION_PATTERN,
  InvalidProtocolVersionError,
  ProtocolVersionSchema,
  isMajorWithinSupportWindow,
  isSupportedProtocolVersion,
  parseProtocolVersion,
  type ProtocolVersion,
} from "./version.js";

export {
  AudienceListSchema,
  AudienceSchema,
  INTERNAL_ONLY,
  isAudienceSubset,
  type Audience,
} from "./audience.js";

export {
  FORBIDDEN_PROP_KEYS,
  MAX_NODE_DEPTH,
  NodePropsSchema,
  ProvenanceSchema,
  UiNodeSchema,
  type UiNode,
} from "./node.js";

export {
  ActionDescriptorSchema,
  ManifestSchema,
  NavEntrySchema,
  ScreenDescriptorSchema,
  ScreenParamSchema,
  type ActionDescriptor,
  type Manifest,
  type NavEntry,
  type ScreenDescriptor,
} from "./manifest.js";

export {
  ActionResponseSchema,
  NavigateSchema,
  PatchSchema,
  ScreenResponseSchema,
  ToastSchema,
  type ActionOutcome,
  type ActionResponse,
  type ScreenResponse,
  type Toast,
} from "./envelopes.js";
