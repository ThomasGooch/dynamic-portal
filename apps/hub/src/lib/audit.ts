import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AuditEventSchema, tenantAuditKey, type AuditEvent, type Principal } from "@portal/identity";

/**
 * Where the audit record goes, and why the hub will not start without one.
 *
 * PLAN.md calls this the artifact a regulator or a client security review asks
 * for, and puts the schema in M1 because retrofitting audit onto a system
 * already handling regulated data is a re-certification rather than a patch.
 * The schema has been right since M1. Until now it had nowhere to go: every
 * path built a valid event and dropped it, which is a more comfortable kind of
 * nothing than having no schema at all, and exactly as useless.
 *
 * **Two settings, both required.** `PORTAL_AUDIT_KEY` is the root secret every
 * tenant's digest key is derived from; `PORTAL_AUDIT_LOG` is the file events
 * are appended to. Neither has a default. A default key produces a log that
 * looks keyed and is not, and a default path produces one nobody knows to
 * collect — both are worse than refusing to run, because both look like
 * success.
 *
 * **Writes fail closed.** If the record cannot be written, the request fails.
 * That is the only posture consistent with calling the audit mandatory: a
 * system that proceeds when it cannot record what it did has an audit log that
 * is evidence of nothing. The operational cost is real and stated in PLAN.md —
 * a full disk is an outage rather than a silent gap, and that is the trade.
 */

interface AuditConfig {
  readonly rootKey: string;
  readonly logPath: string;
}

let config: AuditConfig | undefined;

export function auditConfig(): AuditConfig {
  if (config !== undefined) return config;

  const rootKey = process.env["PORTAL_AUDIT_KEY"];
  const logPath = process.env["PORTAL_AUDIT_LOG"];

  if (!rootKey) {
    throw new Error(
      "PORTAL_AUDIT_KEY is required. Parameter digests are keyed per tenant; " +
        "there is no unkeyed mode to fall back to.",
    );
  }
  if (!logPath) {
    throw new Error(
      "PORTAL_AUDIT_LOG is required. Every screen read, action and tool call is " +
        "recorded, and a log with nowhere to go is not a log.",
    );
  }

  config = { rootKey, logPath };
  return config;
}

/** Test seam: drops the memoised config so a suite can change the environment. */
export function resetAuditConfig(): void {
  config = undefined;
}

/** This tenant's digest key. Derived per request; the derivation is a HMAC. */
export function auditKeyFor(principal: Principal): Buffer {
  return tenantAuditKey(auditConfig().rootKey, principal.tenantId);
}

/**
 * Appends one event, or throws.
 *
 * JSON Lines because an append-only file is the simplest thing that is actually
 * append-only, and because every log shipper on earth reads it. The event is
 * validated first: a record that does not satisfy the schema is not evidence,
 * and finding that out at collection time rather than at write time is finding
 * it out too late.
 */
export async function recordAudit(event: AuditEvent): Promise<void> {
  const parsed = AuditEventSchema.safeParse(event);
  if (!parsed.success) {
    throw new Error(
      `refusing to write an audit record that does not satisfy the schema: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
        .join("; ")}`,
    );
  }

  await appendFile(auditConfig().logPath, `${JSON.stringify(parsed.data)}\n`, "utf8");
}

/** The clock and id generator every builder needs, in one place. */
export function auditStamp(): { readonly id: string; readonly at: string } {
  return { id: randomUUID(), at: new Date().toISOString() };
}
