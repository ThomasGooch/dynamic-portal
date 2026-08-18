import { flatToKeyed, keyedToNested } from "@portal/catalog";
import { runAgent, type Message } from "@portal/agent";
import { signConversation, verifyConversation } from "@portal/identity";
import { visibleSatellites } from "@portal/registry";
import type { AgentApiResult } from "@/lib/agentApi";
import { agentInvoker, buildAgentSurface, isAgentEnabled, modelClient } from "@/lib/agent";
import { auditConfig } from "@/lib/audit";
import { getPortal } from "@/lib/portal";
import { currentPrincipal } from "@/lib/session";

/**
 * One turn of the agent.
 *
 * Stateless, deliberately. The conversation arrives with the request and leaves
 * with the response, so a confirmation that a user takes ten minutes over
 * survives a container restart, and two hub replicas need share nothing.
 *
 * A screen is returned already lowered into the nested tree the renderer takes,
 * so the browser receives exactly the shape a satellite would have sent. The
 * agent path and the deterministic path meet here and are indistinguishable
 * downstream, which is what makes the renderer worth having had first.
 */

/** Drops a trailing assistant turn that still has tool calls nobody answered. */
function dropTrailingUnanswered(messages: readonly Message[]): Message[] {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return [...messages];
  return last.content.some((block) => block.type === "tool_use")
    ? messages.slice(0, -1)
    : [...messages];
}

function json(result: AgentApiResult, status: number): Response {
  return new Response(JSON.stringify(result), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  let principal;
  try {
    principal = currentPrincipal();
  } catch {
    return json({ ok: false, message: "You are not signed in." }, 401);
  }

  if (!isAgentEnabled(principal)) {
    // Not an error. Running without an agent is a supported way to run this
    // portal, and a tenant may have declined AI processing entirely.
    return json({ ok: false, message: "The assistant is not enabled for this account." }, 404);
  }

  let body: {
    history?: unknown;
    signature?: unknown;
    ask?: unknown;
    approvals?: unknown;
    declinePending?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, message: "The portal could not read that request." }, 400);
  }

  let rootKey: string;
  try {
    rootKey = auditConfig().rootKey;
  } catch {
    // A missing root secret is a misconfigured stack, not a bad request. It has
    // to be caught here rather than left to escape the handler: an uncaught
    // throw is a 500 whose body is not the JSON envelope every caller parses,
    // so the browser reports "could not reach the assistant" for a server that
    // answered perfectly well.
    return json({ ok: false, message: "The assistant could not complete that request." }, 502);
  }

  /**
   * Signing and verifying both live in `@portal/identity`, which is where the
   * key derivation and the sealed shape can be held together and tested. The
   * shape matters as much as the key: derived per tenant, a signature over the
   * messages alone verifies for every colleague in that tenant.
   */
  const sign = (messages: readonly Message[]) => signConversation(principal, messages, rootKey);

  /**
   * The conversation is the hub's state, and between turns it lives in the
   * browser. Everything grounding believes about what a tool returned is
   * rebuilt from these blocks, so an unsigned history let a client fabricate a
   * `tool_result` and receive a screen of invented figures wearing a provenance
   * citation.
   *
   * `history` and `ask` are separate fields rather than one array on purpose.
   * The hub signs what it issued; the user then adds to it. Folding the new
   * message into the same array would mean verifying a signature over something
   * the hub never signed, which cannot work — a mistake worth naming because
   * the first version of this did exactly that and would have rejected every
   * second turn.
   */
  const history = Array.isArray(body.history) ? (body.history as Message[]) : [];
  const ask = typeof body.ask === "string" ? body.ask.trim() : "";

  if (history.length > 0) {
    const signature = typeof body.signature === "string" ? body.signature : "";
    if (!verifyConversation(principal, history, signature, rootKey)) {
      return json(
        {
          ok: false,
          message:
            "This conversation could not be verified and has been discarded. Start a new one.",
        },
        400,
      );
    }
  } else if (ask === "") {
    return json({ ok: false, message: "The portal could not read that request." }, 400);
  }

  const approvals = Array.isArray(body.approvals)
    ? body.approvals.filter((id): id is string => typeof id === "string")
    : [];

  /**
   * Declining a pending write by asking something else.
   *
   * A paused write leaves its `tool_use` unanswered, which is what lets the user
   * approve it later. Asking something new instead has to remove it, or the API
   * rejects the conversation before the model sees the question. The *hub* does
   * the removing: the signature covers what the hub issued, so a history the
   * client had already shortened would no longer verify.
   */
  const base = body.declinePending === true ? dropTrailingUnanswered(history) : history;
  const messages: Message[] =
    ask === "" ? base : [...base, { role: "user", content: [{ type: "text", text: ask }] }];

  if (messages.length === 0) {
    return json({ ok: false, message: "The portal could not read that request." }, 400);
  }

  // Declared outside the try so the catch can flush the audit writes a failed
  // turn had already started.
  let invoker: ReturnType<typeof agentInvoker> | undefined;

  try {
    const surface = await buildAgentSurface(principal);
    invoker = agentInvoker(principal, surface);

    const outcome = await runAgent(
      { messages, surface, approvals },
      { client: modelClient(), invoke: invoker.invoke },
    );

    // Every tool call this turn made is on disk before the answer goes out.
    await invoker.flush();

    if (outcome.kind === "screen") {
      const allowed = visibleSatellites(getPortal().registry, principal).map((s) => s.id);
      return json(
        {
          ok: true,
          kind: "screen",
          ui: keyedToNested(flatToKeyed(outcome.spec)),
          citations: outcome.citations,
          allowedSatelliteIds: allowed,
          messages: outcome.messages,
          signature: sign(outcome.messages),
        },
        200,
      );
    }

    if (outcome.kind === "confirm") {
      return json(
        {
          ok: true,
          kind: "confirm",
          pending: outcome.pending,
          messages: outcome.messages,
          signature: sign(outcome.messages),
        },
        200,
      );
    }

    if (outcome.kind === "answer") {
      return json(
        {
          ok: true,
          kind: "answer",
          text: outcome.text,
          messages: outcome.messages,
          signature: sign(outcome.messages),
        },
        200,
      );
    }

    return json({ ok: false, message: outcome.reason }, 200);
  } catch {
    // The turn failed part way through, and the tool calls it did make before
    // failing still happened. Their records are awaited here too — a turn that
    // ended badly is exactly the one an audit is read for — and a write that
    // fails now cannot change an answer that is already a refusal.
    await invoker?.flush().catch(() => {});

    // The model call failed, or a satellite threw where the gateway does not
    // catch. Either way the user gets a sentence, not a stack — the same rule
    // the proxy follows about upstream detail.
    return json({ ok: false, message: "The assistant could not complete that request." }, 502);
  }
}
