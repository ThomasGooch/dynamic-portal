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
 * The largest question the panel will send.
 *
 * Well under the hub's body cap, because the same body also carries the
 * conversation. Counted in bytes rather than characters for the reason the
 * hub counts them that way: `String.length` is UTF-16 code units, so text in
 * most of the world's scripts weighs more than it reads.
 */
const MAX_ASK_BYTES = 32 * 1024;

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** True when the last turn is a write still waiting to be approved. */
function hasPendingCall(messages: readonly Message[]): boolean {
  const last = messages[messages.length - 1];
  return last?.role === "assistant" && last.content.some((block) => block.type === "tool_use");
}

export function AgentPanel() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  // Held beside the conversation it belongs to: the hub refuses a history whose
  // signature does not match, so losing this ends the thread rather than
  // silently starting an unverified one.
  const [signature, setSignature] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);

  async function send(
    body: {
      readonly ask?: string;
      readonly approvals?: readonly string[];
      readonly declinePending?: boolean;
    },
    question: string,
  ): Promise<void> {
    const id = turns.length;

    /**
     * A paste too big to send, refused here so it does not cost the thread.
     *
     * The hub trims the history it issues, so an oversized body is now almost
     * always the thing the user just typed rather than the conversation they
     * built up. Sending it anyway would earn a 413, and the 413 branch below
     * clears the conversation — losing a perfectly good thread to a stray
     * paste. Refusing locally keeps the cost with the paste.
     */
    if (body.ask !== undefined && byteLength(body.ask) > MAX_ASK_BYTES) {
      setTurns((previous) => [
        ...previous,
        {
          id,
          question,
          result: { ok: false, message: "That message is too long to send. Shorten it and try again." },
        },
      ]);
      return;
    }

    setBusy(true);
    setTurns((previous) => [...previous, { id, question, result: undefined }]);

    try {
      const response = await fetch(AGENT_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, history: messages, signature }),
        credentials: "same-origin",
      });
      const result = (await response.json()) as AgentApiResult;

      if (result.ok) {
        setMessages([...result.messages]);
        setSignature(result.signature);
      } else if (response.status === 400 || response.status === 413) {
        // The hub refused the conversation — it did not verify, it is no longer
        // one the API would accept, or it has outgrown the body limit. Keeping
        // it would wedge the panel: every later turn posts the same rejected
        // history and is rejected the same way, with no way out but a reload.
        // The hub's message says to start a new one, so this is the panel
        // actually doing that.
        //
        // 413 is here because the history is the one thing that only ever
        // grows, so it is the one refusal a user can reach without doing
        // anything wrong. Answering it by keeping the conversation that caused
        // it would be a dead end of the panel's own making.
        setMessages([]);
        setSignature("");
      }
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
    // The pending call, if there is one, is dropped by the *hub*: the signature
    // covers the conversation the hub issued, so a history shortened here would
    // no longer verify against it.
    void send({ ask: asked, declinePending: hasPendingCall(messages) }, asked);
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
    void send({ approvals: [pending.toolUseId] }, `Approved: ${pending.title}`);
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
