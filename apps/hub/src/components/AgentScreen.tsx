"use client";

import type { Citation } from "@portal/agent";
import type { UiNode } from "@portal/protocol";
import { ScreenRenderer } from "@/renderer/ScreenRenderer";

/**
 * An agent-composed screen, and the provenance that travels with it.
 *
 * One component rather than one per surface, because provenance is the
 * invariant and not a decoration: a satellite's screen reads as authoritative
 * because a team maintains it, and a derived one has to say which tool calls
 * it came from. PLAN.md asks for that to be always rendered, and the cheapest
 * way to keep it true is for there to be exactly one code path that draws an
 * agent screen — the panel and the composed home both come through here.
 *
 * Deliberately unwrapped. The panel frames it as an answer inside a
 * conversation and the home frames it as a section of the page; a wrapper
 * chosen here would be wrong for one of them, so each supplies its own.
 */
export function AgentScreen({
  ui,
  citations,
  allowed,
}: {
  readonly ui: UiNode;
  readonly citations: readonly Citation[];
  readonly allowed: readonly string[];
}) {
  return (
    <>
      <p className="agentDerived">
        Composed by the assistant from{" "}
        {citations.length === 0 ? "no tool calls" : citations.map((c) => c.toolName).join(", ")}
      </p>
      <ScreenRenderer
        ui={ui}
        // No current satellite, on purpose: an agent-composed screen spans
        // several, so a link that does not name one has nowhere to point and
        // renders inert rather than guessing.
        satelliteId=""
        screenId=""
        params={{}}
        allowedSatelliteIds={allowed}
      />
    </>
  );
}
