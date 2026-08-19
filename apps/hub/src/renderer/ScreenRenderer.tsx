"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ActionResponse, UiNode } from "@portal/protocol";
import { useToaster } from "@/components/Toaster";
import { actionEndpoint, type ActionApiResult } from "@/lib/actionApi";
import { Node } from "./Node";
import { RenderProvider, type ActionRequest } from "./context";
import { resolveLink } from "./links";
import { applyPatches } from "./patch";

/**
 * The screen, and everything that happens to it.
 *
 * This is the only client component the hub mounts per screen. Data fetching,
 * authorization and validation all happened on the server; what crosses the
 * boundary is a tree the proxy already accepted, which is the same JSON the
 * satellite sent. Rendering it here rather than on the server is what lets a
 * `patch` replace one section in place instead of re-rendering the page.
 *
 * The whole `ActionResponse` envelope is honoured here, and that envelope is
 * why satellites ship no JavaScript: `toast` says what happened, `fieldErrors`
 * puts messages back on the fields that caused them, `patch` updates what
 * changed, and `navigate` moves on. A satellite composes those four and has a
 * working workflow.
 */

export interface ScreenRendererProps {
  readonly ui: UiNode;
  readonly satelliteId: string;
  readonly screenId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly allowedSatelliteIds: readonly string[];
}

export function ScreenRenderer(props: ScreenRendererProps) {
  const router = useRouter();

  // The tree currently on screen: the server's, diverging as patches land.
  // `source` records which server tree it came from, so a fresh render — a
  // `router.refresh()`, a navigation — replaces it rather than leaving the user
  // looking at patched-over stale data indefinitely.
  const [tree, setTree] = useState({ source: props.ui, ui: props.ui });

  const { show: setToast } = useToaster();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<ActionRequest | undefined>(undefined);

  if (tree.source !== props.ui) {
    setTree({ source: props.ui, ui: props.ui });
    // The screen changed underneath this component, which stays mounted across
    // a navigation within the portal. Anything keyed to the *previous* screen
    // has to go with it: an error keyed by field `id` would otherwise reappear
    // beside a field of the same name on the screen that replaced it, and a
    // confirmation dialog left open would still be holding the old screen's
    // action.
    setFieldErrors((previous) => (Object.keys(previous).length === 0 ? previous : {}));
    setConfirming(undefined);
  }

  function applyEnvelope(envelope: ActionResponse): void {
    if (envelope.toast !== undefined) setToast(envelope.toast);
    if (envelope.fieldErrors !== undefined) setFieldErrors({ ...envelope.fieldErrors });

    // An envelope may carry more than one of these; each is handled, and only
    // the fallback refetch is skipped once something more specific has run.
    let handled = false;

    if (envelope.patch !== undefined && envelope.patch.length > 0) {
      const patched = applyPatches(tree.ui, envelope.patch);
      if (patched.ok) {
        setTree({ source: tree.source, ui: patched.ui });
        handled = true;
      } else {
        // The action succeeded; only the in-place update did not. Refetching
        // gets the truth, so the satellite's own message stands and the user is
        // told nothing about the hub's internals — but a developer needs the
        // reason, because an unappliable patch usually means the satellite sent
        // one for a screen the user is not on.
        console.warn(`[portal] patch not applied: ${patched.reason}`);
        if (envelope.navigate === undefined) {
          router.refresh();
          return;
        }
        // A navigate is about to fetch a whole screen anyway, so it supersedes
        // the refetch rather than racing it.
      }
    }

    if (envelope.navigate !== undefined) {
      // Resolved through the same allow-list as a `Link`, so a satellite cannot
      // send a user somewhere it could not have linked them.
      const link = resolveLink(envelope.navigate, {
        currentSatelliteId: props.satelliteId,
        allowedSatelliteIds: props.allowedSatelliteIds,
      });
      if (link.kind === "internal") router.push(link.href);
      else setToast({ level: "error", message: "This solution asked to open a screen you cannot reach." });
      return;
    }

    if (handled) return;

    // A failure the satellite described in no other way. Without this the user
    // clicks, the button re-enables, and nothing on the screen says the action
    // did not work.
    if (envelope.outcome === "error" && envelope.toast === undefined) {
      setToast({ level: "error", message: "That action did not complete." });
      return;
    }

    // Something changed and the satellite did not say what, so the screen on
    // display may no longer be true.
    if (envelope.outcome === "ok") router.refresh();
  }

  async function send(request: ActionRequest): Promise<void> {
    setBusy(true);
    // Cleared before the round trip rather than after: leaving the last
    // attempt's errors on the fields while the next is in flight reads as the
    // fix having been rejected again, when nothing has come back yet.
    setFieldErrors({});
    setToast(undefined);

    try {
      /**
       * Multipart only when there is a file, JSON otherwise.
       *
       * The `content-type` is deliberately unset for multipart: the browser
       * appends the boundary it generated, and a header written here would
       * declare a boundary that does not match the body. Every satellite would
       * then read an empty form, which looks like "the file did not attach"
       * rather than "the header was wrong".
       */
      // Present-but-empty means "this form carries files, none were chosen" —
      // still multipart. Absent means an ordinary form.
      const files = request.files;
      const body = (() => {
        if (files === undefined) return JSON.stringify(request.payload);

        // Multipart carries text per field, so the typed payload
        // `collectFormValues` built loses its types here — a number arrives as
        // a number's digits and a boolean as "true"/"false". That is inherent
        // to the encoding and a satellite reading a multipart action knows it.
        //
        // What is *not* acceptable is `String(value)` on a value that has no
        // text form: a `DateRange`, or anything a dotted name nested, encodes
        // as the literal "[object Object]" and the field is simply gone. Those
        // go as JSON, which a satellite can recover; nothing here silently
        // becomes a string that means nothing.
        const encode = (value: unknown): string =>
          typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);

        const form = new FormData();
        for (const [name, value] of Object.entries(request.payload)) {
          if (value === undefined || value === null) continue;
          // Arrays are appended once per entry, which is how a multi-select
          // survives a form encoding — one key repeated, not one key holding
          // a comma-joined string nobody can split back safely.
          if (Array.isArray(value)) for (const entry of value) form.append(name, encode(entry));
          else form.append(name, encode(value));
        }
        for (const [name, file] of files) form.append(name, file, file.name);
        return form;
      })();

      const response = await fetch(actionEndpoint(props.satelliteId, request.actionId), {
        method: "POST",
        ...(files === undefined ? { headers: { "content-type": "application/json" } } : {}),
        body,
        credentials: "same-origin",
      });

      const result = (await response.json()) as ActionApiResult;
      if (result.ok) applyEnvelope(result.response);
      else setToast({ level: "error", message: result.message });
    } catch {
      // A network failure, or a response that was not JSON at all. Either way
      // the outcome is genuinely unknown, and saying so beats implying failure.
      setToast({
        level: "error",
        message: "The portal could not reach this solution. The action may not have run.",
      });
    } finally {
      setBusy(false);
    }
  }

  function dispatch(request: ActionRequest): void {
    if (busy) return;
    if (request.confirm !== undefined) {
      setConfirming(request);
      return;
    }
    void send(request);
  }

  return (
    <RenderProvider
      value={{
        satelliteId: props.satelliteId,
        screenId: props.screenId,
        params: props.params,
        allowedSatelliteIds: props.allowedSatelliteIds,
        fieldErrors,
        busy,
        dispatch,
      }}
    >
      <Node node={tree.ui} />

      {confirming?.confirm !== undefined && (
        <ConfirmDialog
          title={confirming.confirm.title}
          body={confirming.confirm.body}
          onCancel={() => setConfirming(undefined)}
          onConfirm={() => {
            const request = confirming;
            setConfirming(undefined);
            void send(request);
          }}
        />
      )}
    </RenderProvider>
  );
}

/**
 * The hub's confirmation, not the browser's.
 *
 * `window.confirm` would work and would be one line, but it is unstyled, blocks
 * the event loop, and — the part that matters for the governed-write path in
 * M2 — has nowhere to show what is about to happen. The same dialog serves a
 * satellite asking "approve this order?" and, later, an agent asking to run a
 * tool that writes.
 */
function ConfirmDialog({
  title,
  body,
  onCancel,
  onConfirm,
}: {
  title: string;
  body?: string | undefined;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="r-modalBackdrop">
      <div
        className="r-modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        data-size="sm"
      >
        <div className="r-modalHead">
          <h2 className="r-title">{title}</h2>
        </div>
        {body !== undefined && <p>{body}</p>}
        <div className="r-formActions">
          <button type="button" className="r-button" data-variant="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="r-button" data-variant="primary" onClick={onConfirm}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
