"use client";

import { useEffect, useState } from "react";
import type { Citation } from "@portal/agent";
import type { UiNode } from "@portal/protocol";
import { AGENT_ENDPOINT, type AgentApiResult } from "@/lib/agentApi";
import { ScreenRenderer } from "@/renderer/ScreenRenderer";

/**
 * A home screen nobody wrote.
 *
 * The last thing PLAN.md asks of M2, and the one that only makes sense once
 * everything under it exists: the agent reads across every solution this
 * account can see and composes a screen from what it finds. No satellite owns
 * this view, and no team maintains it — which is exactly why it is the answer
 * to "what is the hub for, beyond consistent styling".
 *
 * **Additive, never load-bearing.** The launcher above renders server-side and
 * is a complete home page on its own. This mounts afterwards, asks, and fills
 * in if an answer arrives. With the assistant off, a tenant opted out, or the
 * model unreachable, the page is what it always was and says nothing about a
 * missing feature — which is the property PLAN.md asks for and the one a
 * compliance review asks about.
 *
 * Composed per visit rather than cached. That is honest for a prototype and
 * wrong for production: a model call on every home load is slow and costs
 * money per view. The fix is a per-tenant cache with a short TTL, and it is
 * recorded in PLAN.md rather than pretended away.
 */

const ASK =
  "Compose a short screen showing what needs attention across every solution I can see. " +
  "Use the tools to fetch real figures, then lay them out as stat tiles with a heading. " +
  "Keep it to the few things that would change what I do today.";

type State =
  | { readonly status: "asking" }
  | { readonly status: "ready"; readonly ui: UiNode; readonly citations: readonly Citation[]; readonly allowed: readonly string[] }
  | { readonly status: "silent" };

export function ComposedHome() {
  const [state, setState] = useState<State>({ status: "asking" });

  useEffect(() => {
    // Abort on unmount: composing takes tens of seconds, and a user who has
    // already navigated away should not have a reply arrive into a component
    // that is gone.
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(AGENT_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ask: ASK }),
          credentials: "same-origin",
          signal: controller.signal,
        });

        const result = (await response.json()) as AgentApiResult;
        if (result.ok && result.kind === "screen") {
          setState({
            status: "ready",
            ui: result.ui,
            citations: result.citations,
            allowed: result.allowedSatelliteIds,
          });
          return;
        }
        // An answer in prose, a refusal, or the assistant switched off. None of
        // them is an error worth showing on a launcher that already works.
        setState({ status: "silent" });
      } catch {
        setState({ status: "silent" });
      }
    })();

    return () => controller.abort();
  }, []);

  if (state.status === "silent") return null;

  return (
    <section className="composedHome" aria-live="polite">
      <div className="screenHeader">
        <h2>Needs attention</h2>
      </div>

      {state.status === "asking" ? (
        <p className="r-muted">Reading across your solutions…</p>
      ) : (
        <>
          {/*
            Provenance, always. A satellite's screen reads as authoritative
            because a team maintains it; this one is derived, and every figure
            on it came from a tool call named here.
          */}
          <p className="agentDerived">
            Composed by the assistant from{" "}
            {state.citations.length === 0
              ? "no tool calls"
              : state.citations.map((citation) => citation.toolName).join(", ")}
          </p>
          <ScreenRenderer
            ui={state.ui}
            // No current satellite: this screen spans several, so a link that
            // does not name one has nowhere to point and renders inert rather
            // than guessing.
            satelliteId=""
            screenId=""
            params={{}}
            allowedSatelliteIds={state.allowed}
          />
        </>
      )}
    </section>
  );
}
