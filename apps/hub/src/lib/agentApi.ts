import type { Citation, Message, PendingWrite } from "@portal/agent";
import type { UiNode } from "@portal/protocol";

/**
 * The conversation, and the hub's signature over it.
 *
 * Sent with every successful turn and required on the next one. The
 * conversation is the hub's state, and it lives in the browser between turns —
 * so the hub has to be able to tell whether what came back is what it sent.
 */
export interface SignedConversation {
  readonly messages: readonly Message[];
  readonly signature: string;
}

/**
 * What the agent endpoint answers.
 *
 * Shared by the route and the panel so the two cannot drift. The conversation
 * comes back on every outcome, because the client is where it lives between
 * turns — see the route for why the hub keeps none of it.
 */
export type AgentApiResult =
  | (SignedConversation & {
      readonly ok: true;
      readonly kind: "screen";
      /** Already the nested tree the renderer takes, exactly as a satellite would send. */
      readonly ui: UiNode;
      readonly citations: readonly Citation[];
      readonly allowedSatelliteIds: readonly string[];
    })
  | (SignedConversation & {
      readonly ok: true;
      readonly kind: "answer";
      readonly text: string;
    })
  | (SignedConversation & {
      readonly ok: true;
      readonly kind: "confirm";
      readonly pending: PendingWrite;
    })
  | { readonly ok: false; readonly message: string };

export const AGENT_ENDPOINT = "/api/agent";
