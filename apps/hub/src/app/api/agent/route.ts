import { flatToKeyed, keyedToNested } from "@portal/catalog";
import { runAgent, type Message } from "@portal/agent";
import { visibleSatellites } from "@portal/registry";
import type { AgentApiResult } from "@/lib/agentApi";
import { agentInvoker, buildAgentSurface, isAgentEnabled, modelClient } from "@/lib/agent";
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

  let body: { messages?: unknown; approvals?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, message: "The portal could not read that request." }, 400);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return json({ ok: false, message: "The portal could not read that request." }, 400);
  }

  const approvals = Array.isArray(body.approvals)
    ? body.approvals.filter((id): id is string => typeof id === "string")
    : [];

  try {
    const surface = await buildAgentSurface(principal);
    const invoker = agentInvoker(principal, surface);

    const outcome = await runAgent(
      { messages: body.messages as Message[], surface, approvals },
      { client: modelClient(), invoke: invoker.invoke },
    );

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
        },
        200,
      );
    }

    if (outcome.kind === "confirm") {
      return json(
        { ok: true, kind: "confirm", pending: outcome.pending, messages: outcome.messages },
        200,
      );
    }

    if (outcome.kind === "answer") {
      return json({ ok: true, kind: "answer", text: outcome.text, messages: outcome.messages }, 200);
    }

    return json({ ok: false, message: outcome.reason }, 200);
  } catch {
    // The model call failed, or a satellite threw where the gateway does not
    // catch. Either way the user gets a sentence, not a stack — the same rule
    // the proxy follows about upstream detail.
    return json({ ok: false, message: "The assistant could not complete that request." }, 502);
  }
}
