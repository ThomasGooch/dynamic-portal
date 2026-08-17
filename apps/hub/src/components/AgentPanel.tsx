"use client";

import { useState } from "react";
import type { Citation, Message, PendingWrite } from "@portal/agent";
import type { UiNode } from "@portal/protocol";
import { AGENT_ENDPOINT, type AgentApiResult } from "@/lib/agentApi";
import { ScreenRenderer } from "@/renderer/ScreenRenderer";

/**
 * The assistant, beside the portal rather than instead of it.
 *
 * Everything it produces is visibly derived. A satellite's screen reads as
 * authoritative because a team maintains it; this one reads as an answer,
 * carries the tool calls it came from, and says so above the content. PLAN.md
 * asks for provenance to be always rendered, and the cheapest way to keep that
 * true is for there to be no code path that draws an agent screen without it.
 */

interface Turn {
  readonly id: number;
  readonly question: string;
  readonly result: AgentApiResult | undefined;
}

/**
 * Declining a confirmation by asking something else.
 *
 * A paused write leaves its `tool_use` in the history with nothing answering
 * it, which is exactly what lets the user approve it later. If they type a new
 * question instead, that unanswered call has to go: a conversation carrying one
 * is rejected before the model ever sees the new question, and the panel would
 * be wedged for the rest of the session with no way out but a reload.
 */
function withoutPendingCalls(messages: readonly Message[]): Message[] {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return [...messages];
  return last.content.some((block) => block.type === "tool_use")
    ? messages.slice(0, -1)
    : [...messages];
}

export function AgentPanel() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);

  async function send(next: Message[], approvals: string[], question: string): Promise<void> {
    setBusy(true);
    const id = turns.length;
    setTurns((previous) => [...previous, { id, question, result: undefined }]);

    try {
      const response = await fetch(AGENT_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: next, approvals }),
        credentials: "same-origin",
      });
      const result = (await response.json()) as AgentApiResult;

      if (result.ok) setMessages([...result.messages]);
      setTurns((previous) => previous.map((turn) => (turn.id === id ? { ...turn, result } : turn)));
    } catch {
      setTurns((previous) =>
        previous.map((turn) =>
          turn.id === id
            ? { ...turn, result: { ok: false, message: "The portal could not reach the assistant." } }
            : turn,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  function ask(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const asked = question.trim();
    if (asked === "" || busy) return;
    setQuestion("");
    const history = withoutPendingCalls(messages);
    setMessages(history);
    void send([...history, { role: "user", content: [{ type: "text", text: asked }] }], [], asked);
  }

  if (!open) {
    return (
      <button type="button" className="agentToggle" onClick={() => setOpen(true)}>
        Ask the portal
      </button>
    );
  }

  return (
    <aside className="agentPanel" aria-label="Assistant">
      <header className="agentHead">
        <strong>Assistant</strong>
        <button type="button" className="r-iconButton" onClick={() => setOpen(false)} aria-label="Close">
          ×
        </button>
      </header>

      <div className="agentLog">
        {turns.length === 0 && (
          <p className="r-muted">
            Ask across every solution you can see. Answers are drawn from the tools, and each one
            says which.
          </p>
        )}

        {turns.map((turn) => (
          <div className="agentTurn" key={turn.id}>
            <p className="agentQuestion">{turn.question}</p>
            {turn.result === undefined ? (
              <p className="r-muted">Working…</p>
            ) : (
              <Answer result={turn.result} onApprove={(pending) => approve(pending)} busy={busy} />
            )}
          </div>
        ))}
      </div>

      <form className="agentAsk" onSubmit={ask}>
        <input
          className="r-input"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Which orders are blocked?"
          disabled={busy}
          aria-label="Ask the assistant"
        />
        <button type="submit" className="r-button" data-variant="primary" disabled={busy}>
          Ask
        </button>
      </form>
    </aside>
  );

  function approve(pending: PendingWrite): void {
    void send(messages, [pending.toolUseId], `Approved: ${pending.title}`);
  }
}

function Answer({
  result,
  onApprove,
  busy,
}: {
  result: AgentApiResult;
  onApprove: (pending: PendingWrite) => void;
  busy: boolean;
}) {
  if (!result.ok) {
    return (
      <div className="r-alert" data-level="error" role="alert">
        <span>{result.message}</span>
      </div>
    );
  }

  if (result.kind === "answer") return <p className="agentText">{result.text}</p>;

  if (result.kind === "confirm") {
    return (
      <div className="agentConfirm">
        <strong>{result.pending.title}</strong>
        <p className="r-muted">{result.pending.description}</p>
        <dl className="r-kv">
          {Object.entries(result.pending.args).map(([key, value]) => (
            <div className="r-kvRow" key={key}>
              <dt>{key}</dt>
              <dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
            </div>
          ))}
        </dl>
        <button
          type="button"
          className="r-button"
          data-variant="primary"
          disabled={busy}
          onClick={() => onApprove(result.pending)}
        >
          Approve and run
        </button>
      </div>
    );
  }

  return <AgentScreen ui={result.ui} citations={result.citations} allowed={result.allowedSatelliteIds} />;
}

function AgentScreen({
  ui,
  citations,
  allowed,
}: {
  ui: UiNode;
  citations: readonly Citation[];
  allowed: readonly string[];
}) {
  return (
    <div className="agentScreen">
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
    </div>
  );
}
