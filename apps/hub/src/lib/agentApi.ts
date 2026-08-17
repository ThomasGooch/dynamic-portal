import type { Citation, Message, PendingWrite } from "@portal/agent";
import type { UiNode } from "@portal/protocol";

/**
 * What the agent endpoint answers.
 *
 * Shared by the route and the panel so the two cannot drift. The conversation
 * comes back on every outcome, because the client is where it lives between
 * turns — see the route for why the hub keeps none of it.
 */
export type AgentApiResult =
  | {
      readonly ok: true;
      readonly kind: "screen";
      /** Already the nested tree the renderer takes, exactly as a satellite would send. */
      readonly ui: UiNode;
      readonly citations: readonly Citation[];
      readonly allowedSatelliteIds: readonly string[];
      readonly messages: readonly Message[];
    }
  | {
      readonly ok: true;
      readonly kind: "answer";
      readonly text: string;
      readonly messages: readonly Message[];
    }
  | {
      readonly ok: true;
      readonly kind: "confirm";
      readonly pending: PendingWrite;
      readonly messages: readonly Message[];
    }
  | { readonly ok: false; readonly message: string };

export const AGENT_ENDPOINT = "/api/agent";
