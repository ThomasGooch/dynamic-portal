"use client";

import { useEffect, useState } from "react";
import type { Citation, Message, PendingWrite } from "@portal/agent";
import type { UiNode } from "@portal/protocol";
import { AGENT_ENDPOINT, type AgentApiResult } from "@/lib/agentApi";
import {
  CONVERSATION_STORAGE_KEY,
  decodeConversation,
  encodeConversation,
  forDisplay,
  type Turn,
  type TurnResult,
} from "@/lib/agentConversation";
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

export function AgentPanel({ owner }: { owner: string }) {
  // Restored in one pass rather than in an effect: reading it after mount
  // would render an empty panel first and pop the conversation in a frame
  // later, which reads as a bug even when it settles correctly. The rules the
  // restore applies — whose thread this is, what shape it has to be in — live
  // in `@/lib/agentConversation`, where a unit test can reach them.
  const saved = useState(() => {
    // Server-rendered first, so there is no `window` on the first pass.
    if (typeof window === "undefined") return undefined;
    try {
      return decodeConversation(window.sessionStorage.getItem(CONVERSATION_STORAGE_KEY), owner);
    } catch {
      // Disabled or partitioned storage throws on read. No storage, then.
      return undefined;
    }
  })[0];

  const [open, setOpen] = useState(saved?.open ?? false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>(saved?.messages ?? []);
  // Held beside the conversation it belongs to: the hub refuses a history whose
  // signature does not match, so losing this ends the thread rather than
  // silently starting an unverified one.
  const [signature, setSignature] = useState(saved?.signature ?? "");
  const [turns, setTurns] = useState<Turn[]>(saved?.turns ?? []);
  const [busy, setBusy] = useState(false);

  /**
   * Whether hydration has happened, which is what says the restored state may
   * be *drawn*.
   *
   * The server had no `sessionStorage` to read, so it rendered the collapsed
   * toggle. Painting the open panel on the first client pass instead is a
   * hydration mismatch — Next's own guidance on client-only state says as much
   * — and React answers one by discarding the server tree and client-rendering
   * from the nearest boundary, of which this app has none above the layout.
   *
   * So the conversation is still restored in one pass, and only the open/closed
   * state waits: the panel opens a frame late, already holding its turns,
   * rather than opening on time and taking the shell's hydration with it.
   */
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  /**
   * Written on every change, so the next full page load finds it.
   *
   * Quota failures are swallowed. A screen result carries its whole UI tree,
   * so a long conversation can outgrow the few megabytes a browser allows —
   * and losing the ability to *restore* a thread is a far smaller harm than
   * throwing while rendering the shell that holds it.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (messages.length === 0 && turns.length === 0 && !open) {
        window.sessionStorage.removeItem(CONVERSATION_STORAGE_KEY);
        return;
      }
      window.sessionStorage.setItem(
        CONVERSATION_STORAGE_KEY,
        encodeConversation({ owner, open, messages, signature, turns }),
      );
    } catch {
      // Full, disabled, or private-mode storage. The panel still works; it
      // just will not survive the next navigation.
    }
  }, [owner, open, messages, signature, turns]);

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
      // `forDisplay` drops the signed conversation the result also carried: it
      // is already held in state above, and a copy per turn is what makes a
      // long thread outgrow the storage it is kept in.
      const shown = forDisplay(result);
      setTurns((previous) =>
        previous.map((turn) => (turn.id === id ? { ...turn, result: shown } : turn)),
      );
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
    // Cleared only when it is actually going to be sent. `send` refuses an
    // oversized ask with "shorten it and try again", which a user cannot do if
    // the box has already been emptied out from under them.
    if (byteLength(asked) <= MAX_ASK_BYTES) setQuestion("");
    // The pending call, if there is one, is dropped by the *hub*: the signature
    // covers the conversation the hub issued, so a history shortened here would
    // no longer verify against it.
    void send({ ask: asked, declinePending: hasPendingCall(messages) }, asked);
  }

  if (!open || !hydrated) {
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
        {/*
          Grouped rather than dropped straight into the header, because the
          header is `justify-content: space-between`: a third child lands in the
          middle of it, and this one appears only once there is a turn — so the
          close button would slide sideways the moment a question is asked.
        */}
        <div className="agentHeadActions">
          {/*
            A conversation now outlives the screen it started on, so there has
            to be a way to end one. Before it was persisted, navigating anywhere
            did that by accident — which was the bug, but it was also the only
            exit.
          */}
          {turns.length > 0 && (
            <button
              type="button"
              className="r-button"
              data-variant="ghost"
              data-size="sm"
              onClick={() => {
                setMessages([]);
                setSignature("");
                setTurns([]);
              }}
              disabled={busy}
            >
              New conversation
            </button>
          )}
          <button type="button" className="r-iconButton" onClick={() => setOpen(false)} aria-label="Close">
            ×
          </button>
        </div>
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
  result: TurnResult;
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
