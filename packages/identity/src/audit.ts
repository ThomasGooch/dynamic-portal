import { createHmac } from "node:crypto";
import { z } from "zod";
import { AudienceSchema } from "@portal/protocol";
import type { Principal } from "./principal";

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
 * **Parameters are digested under a per-tenant key, never stored.** They carry
 * regulated data. The digest proves *what was asked* — the same request always
 * yields the same value — without the record becoming a copy of the data it
 * describes.
 *
 * The key is what makes that a confidentiality claim rather than a hope. An
 * unkeyed SHA-256 over a low-entropy parameter — an order id, a national
 * insurance number — is recoverable by anyone holding the log and a candidate
 * list, which is most people who would ever read it. This started life unkeyed,
 * with a comment saying so and a note to fix it before the log was exported;
 * keying it is not optional now and there is no unkeyed path left to fall back
 * to.
 *
 * Per *tenant*, not per deployment, so a digest from one tenant's records
 * cannot be matched against another's, and handing one tenant their own log
 * gives them nothing about anyone else's.
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
 * The per-tenant key, derived from one configured secret.
 *
 * Derived rather than configured per tenant because an operator managing one
 * secret manages it well and an operator managing forty rotates none of them.
 * The label is versioned so the derivation can change without silently
 * producing digests that collide with the old scheme.
 */
export function tenantAuditKey(rootKey: string, tenantId: string): Buffer {
  if (rootKey === "") throw new Error("an audit key is required; there is no unkeyed digest");
  return createHmac("sha256", rootKey).update(`portal.audit.v1:${tenantId}`, "utf8").digest();
}

/**
 * A stable digest of a value under a tenant's key, independent of key insertion
 * order.
 *
 * Order-independence is what makes the digest comparable at all: two identical
 * requests serialised by different code paths must agree. Array order is
 * preserved, because in an argument list order is meaning.
 */
export function auditDigest(value: unknown, key: Buffer): string {
  return createHmac("sha256", key).update(canonicalize(value), "utf8").digest("hex");
}

/** A step in the walk: a value still to expand, or literal text to emit. */
type CanonicalTask =
  | { readonly expand: unknown }
  | { readonly emit: string; readonly leave?: object | undefined };

/**
 * Iterative, deliberately.
 *
 * The values digested here are request parameters and tool arguments, so their
 * nesting depth is chosen by the caller. A recursive walk overflows the stack
 * on a deep object — a `RangeError` thrown out of the audit path, on a request
 * that had already been authorized and served.
 */
function canonicalize(root: unknown): string {
  const out: string[] = [];
  const stack: CanonicalTask[] = [{ expand: root }];
  // Containers currently open on the path from the root, so a cycle is a
  // rejection rather than an unbounded loop.
  const open = new Set<object>();

  while (stack.length > 0) {
    const task = stack.pop()!;

    if ("emit" in task) {
      if (task.leave !== undefined) open.delete(task.leave);
      out.push(task.emit);
      continue;
    }

    const value = task.expand;

    // `undefined` is distinct from `null` and from an absent key. Collapsing
    // them would let two different requests share a digest, which is the one
    // property the record depends on.
    if (value === undefined) {
      out.push("undefined");
      continue;
    }
    if (typeof value === "bigint") {
      // `JSON.stringify` throws on a bigint; a digest must not be the thing
      // that fails the request.
      out.push(`${value}n`);
      continue;
    }
    if (value === null || typeof value !== "object") {
      // `JSON.stringify` yields undefined for functions and symbols.
      out.push(JSON.stringify(value) ?? "undefined");
      continue;
    }

    // Dates and other `toJSON` carriers enumerate to zero own properties, so
    // without this every Date would digest identically to every other Date —
    // and to `{}`.
    const toJson = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJson === "function") {
      stack.push({ expand: (toJson as (key?: string) => unknown).call(value) });
      continue;
    }

    if (open.has(value)) throw new TypeError("cannot digest a circular structure");
    open.add(value);

    if (Array.isArray(value)) {
      out.push("[");
      // Pushed back to front, because the stack pops in reverse.
      stack.push({ emit: "]", leave: value });
      for (let i = value.length - 1; i >= 0; i -= 1) {
        stack.push({ expand: value[i] });
        if (i > 0) stack.push({ emit: "," });
      }
      continue;
    }

    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    out.push("{");
    stack.push({ emit: "}", leave: value });
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const [key, entryValue] = entries[i]!;
      stack.push({ expand: entryValue });
      stack.push({ emit: `${JSON.stringify(key)}:` });
      if (i > 0) stack.push({ emit: "," });
    }
  }

  return out.join("");
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
  /**
   * This tenant's digest key, from `tenantAuditKey`.
   *
   * Required on every builder rather than defaulted, because a default is how a
   * deployment ends up with an unkeyed log that looks exactly like a keyed one.
   */
  readonly auditKey: Buffer;
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
      paramsDigest: auditDigest(input.params, input.auditKey),
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
      paramsDigest: auditDigest(input.params, input.auditKey),
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
      paramsDigest: auditDigest(input.args, input.auditKey),
      ...(input.subjects !== undefined ? { subjects: [...input.subjects] } : {}),
    },
    outcome: input.outcome,
    latencyMs: input.latencyMs,
  };
}

/**
 * `subjects` is excluded from the input rather than ignored: an `agent.compose`
 * record has no field to carry it, so accepting one would silently drop the
 * identifiers a caller had decided were safe to retain. The subjects belong on
 * the `tool.call` records this event cites.
 */
export function agentCompose(
  input: Omit<BaseInput, "subjects"> & { screenId: string; toolCallIds: readonly string[] },
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
