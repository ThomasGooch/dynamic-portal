"use client";

import { useEffect, useState } from "react";
import type { Citation } from "@portal/agent";
import type { UiNode } from "@portal/protocol";
import { AGENT_ENDPOINT, type AgentApiResult } from "@/lib/agentApi";
import { AgentScreen } from "@/components/AgentScreen";

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
 *
 * Two calls per load under StrictMode, and aborting recovers only the browser
 * half. `/api/agent` does not observe `request.signal`, so the turn the first
 * effect started runs to completion on the server — a full model turn, paid
 * for, with nowhere to go. It is a development-only cost today because
 * StrictMode double-invocation is, but it is the same reason the cache above
 * is the real fix: the client cannot make a turn cheap by giving up on it.
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

    // Nothing this effect learns after it has been torn down may reach the
    // screen. React's StrictMode — on in this app, `reactStrictMode: true` in
    // `next.config.ts` — runs the effect, tears it down, and runs it again, so
    // the first fetch rejects with `AbortError` while the second is still in
    // flight. Without this guard that rejection took the shared `catch` below
    // and set `silent`, which returns `null`: the "Reading across your
    // solutions…" line vanished, the `aria-live` region was removed from the
    // tree and re-added, and a screen reader was told the section had gone. It
    // recovered when the second answer landed, which is precisely why nothing
    // caught it. The same path runs on a real unmount, where the component is
    // gone and the update is pure waste.
    const settle = (next: State): void => {
      if (controller.signal.aborted) return;
      setState(next);
    };

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
          settle({
            status: "ready",
            ui: result.ui,
            citations: result.citations,
            allowed: result.allowedSatelliteIds,
          });
          return;
        }
        // An answer in prose, a refusal, or the assistant switched off. None of
        // them is an error worth showing on a launcher that already works.
        settle({ status: "silent" });
      } catch {
        settle({ status: "silent" });
      }
    })();

    return () => controller.abort();
  }, []);

  if (state.status === "silent") return null;

  return (
    /*
      `aria-busy` on the section, and the live region only on the line that is
      actually a status.

      It was `aria-live="polite"` on the whole section, which is a different
      promise than it looks: everything inserted into a live region gets read
      out, and what lands here is a dashboard. A screen reader user waiting for
      the launcher would have had the heading, the provenance line, every stat
      tile and any table announced at them, unprompted, tens of seconds after
      they stopped looking at this part of the page — the most disruptive
      possible way to deliver a section whose entire premise is that it is
      additive and skippable.

      A short status announced politely is the useful half of that, and
      `aria-busy` is how the section says it is still filling in without
      narrating the result. The composed screen itself is ordinary page content
      and is read when it is reached, like the launcher above it.
    */
    <section className="composedHome" aria-busy={state.status === "asking"}>
      <div className="screenHeader">
        <h2>Needs attention</h2>
      </div>

      {state.status === "asking" ? (
        <p className="r-muted" role="status">
          Reading across your solutions…
        </p>
      ) : (
        // The same component the panel draws, so provenance cannot be present
        // on one surface and forgotten on the other.
        <AgentScreen ui={state.ui} citations={state.citations} allowed={state.allowed} />
      )}
    </section>
  );
}
