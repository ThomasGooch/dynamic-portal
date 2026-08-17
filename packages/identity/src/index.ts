/**
 * Principal, tenancy, audience and the audit record.
 *
 * `PLAN.md` calls this the part you cannot refactor later, and puts it in M1
 * for that reason. Everything else in the workspace is replaceable behind a
 * seam; the identity and audit model is not.
 */

export {
  InvalidPrincipalError,
  PrincipalSchema,
  signPrincipal,
  verifyPrincipal,
  type Principal,
} from "./principal";

export {
  authorize,
  type AuthorizationResult,
  type AuthorizationTarget,
} from "./authorize";

export {
  AuditEventSchema,
  actionInvoke,
  agentCompose,
  auditDigest,
  tenantAuditKey,
  screenRead,
  toolCall,
  type AuditEvent,
  type AuditOutcome,
} from "./audit";
