import { createHash } from "node:crypto";
import { z } from "zod";
import { AudienceSchema } from "@portal/protocol";
import type { Principal } from "./principal.js";

/**
 * The audit record — a schema, not a log format.
 *
 * This is the artifact a regulator or a client security review asks for, which
 * is why it is designed now rather than derived later from whatever the
 * application happened to log. Retrofitting audit onto a system already
 * handling regulated data is a re-certification, not a patch.
 *
 * Two deliberate choices:
 *
 * **Parameters are digested, never stored.** They carry regulated data. The
 * digest proves *what was asked* — the same request always yields the same
 * value — without the record itself becoming a copy of the data it describes.
 *
 * **`subjects` exists because a digest cannot answer "which records".** A
 * digest is one-way, so it cannot be read back to enumerate what was touched.
 * A caller that needs that question answerable declares the identifiers it
 * considers safe to retain (`order:ord-1001`). It is opt-in per call, so the
 * decision about what is safe to keep sits with whoever knows the data.
 *
 * Scopes are absent on purpose: they are authorization *input*, not evidence of
 * what happened, and recording them would leak the shape of the permission
 * model into a log that is read widely.
 */

const OutcomeSchema = z
  .object({
    status: z.enum(["ok", "denied", "error"]),
    httpStatus: z.number().int().optional(),
    reason: z.string().optional(),
  })
  .strict();

/** Only the identifying fields of a principal — never its scopes. */
const ActorSchema = z
  .object({
    sub: z.string().min(1),
    tenantId: z.string().min(1),
    audience: AudienceSchema,
  })
  .strict();

const Digest = z.string().regex(/^[a-f0-9]{64}$/);

const ScreenReadSchema = z
  .object({
    kind: z.literal("screen.read"),
    satelliteId: z.string().min(1),
    screenId: z.string().min(1),
    paramsDigest: Digest,
    subjects: z.array(z.string().min(1)).optional(),
  })
  .strict();

const ActionInvokeSchema = z
  .object({
    kind: z.literal("action.invoke"),
    satelliteId: z.string().min(1),
    actionId: z.string().min(1),
    paramsDigest: Digest,
    subjects: z.array(z.string().min(1)).optional(),
  })
  .strict();

const ToolCallSchema = z
  .object({
    kind: z.literal("tool.call"),
    satelliteId: z.string().min(1),
    toolName: z.string().min(1),
    /**
     * The id an agent-composed screen cites in `source`. This is what makes
     * the grounding rule answerable: every rendered number resolves to one of
     * these records, so "which records did the agent read, for whom, when" is a
     * query rather than an investigation.
     */
    toolCallId: z.string().min(1),
    paramsDigest: Digest,
    subjects: z.array(z.string().min(1)).optional(),
  })
  .strict();

const AgentComposeSchema = z
  .object({
    kind: z.literal("agent.compose"),
    screenId: z.string().min(1),
    /** Every tool call whose result appears on the rendered screen. */
    toolCallIds: z.array(z.string().min(1)),
  })
  .strict();

export const AuditEventSchema = z
  .object({
    id: z.string().min(1),
    at: z.string().datetime(),
    principal: ActorSchema,
    action: z.discriminatedUnion("kind", [
      ScreenReadSchema,
      ActionInvokeSchema,
      ToolCallSchema,
      AgentComposeSchema,
    ]),
    outcome: OutcomeSchema,
    latencyMs: z.number().int().nonnegative(),
  })
  .strict();

export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AuditOutcome = z.infer<typeof OutcomeSchema>;

/**
 * A stable hash of a value, independent of key insertion order.
 *
 * Order-independence is what makes the digest comparable at all: two identical
 * requests serialised by different code paths must agree. Array order is
 * preserved, because in an argument list order is meaning.
 */
export function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

const actor = (principal: Principal): z.infer<typeof ActorSchema> => ({
  sub: principal.sub,
  tenantId: principal.tenantId,
  audience: principal.audience,
});

interface BaseInput {
  readonly id: string;
  readonly at: string;
  readonly principal: Principal;
  readonly outcome: AuditOutcome;
  readonly latencyMs: number;
  readonly subjects?: readonly string[];
}

export function screenRead(
  input: BaseInput & { satelliteId: string; screenId: string; params: unknown },
): AuditEvent {
  return {
    id: input.id,
    at: input.at,
    principal: actor(input.principal),
    action: {
      kind: "screen.read",
      satelliteId: input.satelliteId,
      screenId: input.screenId,
      paramsDigest: canonicalDigest(input.params),
      ...(input.subjects !== undefined ? { subjects: [...input.subjects] } : {}),
    },
    outcome: input.outcome,
    latencyMs: input.latencyMs,
  };
}

export function actionInvoke(
  input: BaseInput & { satelliteId: string; actionId: string; params: unknown },
): AuditEvent {
  return {
    id: input.id,
    at: input.at,
    principal: actor(input.principal),
    action: {
      kind: "action.invoke",
      satelliteId: input.satelliteId,
      actionId: input.actionId,
      paramsDigest: canonicalDigest(input.params),
      ...(input.subjects !== undefined ? { subjects: [...input.subjects] } : {}),
    },
    outcome: input.outcome,
    latencyMs: input.latencyMs,
  };
}

export function toolCall(
  input: BaseInput & {
    satelliteId: string;
    toolName: string;
    toolCallId: string;
    args: unknown;
  },
): AuditEvent {
  return {
    id: input.id,
    at: input.at,
    principal: actor(input.principal),
    action: {
      kind: "tool.call",
      satelliteId: input.satelliteId,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      paramsDigest: canonicalDigest(input.args),
      ...(input.subjects !== undefined ? { subjects: [...input.subjects] } : {}),
    },
    outcome: input.outcome,
    latencyMs: input.latencyMs,
  };
}

export function agentCompose(
  input: BaseInput & { screenId: string; toolCallIds: readonly string[] },
): AuditEvent {
  return {
    id: input.id,
    at: input.at,
    principal: actor(input.principal),
    action: {
      kind: "agent.compose",
      screenId: input.screenId,
      toolCallIds: [...input.toolCallIds],
    },
    outcome: input.outcome,
    latencyMs: input.latencyMs,
  };
}
