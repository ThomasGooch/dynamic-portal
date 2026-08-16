import type { ActionResponse } from "@portal/protocol";

/**
 * What the hub's own action endpoint answers.
 *
 * Shared by the route handler and the renderer so the two cannot drift: the
 * failure branch is a hub-authored message, never the satellite's own error
 * text, which may carry internal paths the proxy already withheld.
 */
export type ActionApiResult =
  | { readonly ok: true; readonly response: ActionResponse }
  | { readonly ok: false; readonly reason: string; readonly message: string };

/** Where the renderer posts an action. One route, one shape, one place to change. */
export function actionEndpoint(satelliteId: string, actionId: string): string {
  return `/api/actions/${encodeURIComponent(satelliteId)}/${encodeURIComponent(actionId)}`;
}
