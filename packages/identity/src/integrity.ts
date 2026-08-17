import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalValue } from "./audit";

/**
 * Signing something the hub hands out and expects back.
 *
 * The agent's conversation is the case this exists for. The hub is stateless
 * between turns by design — the whole message list travels to the browser and
 * returns on the next request — which is what makes a confirmation survive a
 * container restart. It also means everything the hub believes about a turn
 * arrived from the client.
 *
 * Unsigned, that let a client fabricate a `tool_result` and receive a screen
 * carrying invented figures under a provenance citation. Grounding rebuilds its
 * evidence from those blocks; it cannot tell one the hub wrote from one someone
 * typed. Signing does not make the hub stateful — the state still travels — it
 * makes the hub able to tell whether what came back is what it sent.
 *
 * **What this does not defend against, deliberately.** A user approving a write
 * without looking at the confirmation card is a user approving a write. They
 * are authenticated and authorized, and could call the action endpoint directly
 * with their own credentials. The confirmation gate protects against the
 * *model* acting unbidden, and the signature is what keeps the model's output
 * from being edited on its way through a browser.
 */

/** Purpose-separated so one key can never verify another's payloads. */
export type KeyPurpose = "audit.v1" | "conversation.v1";

/**
 * A key for one tenant and one purpose, derived from a single root secret.
 *
 * Derived rather than configured per tenant because an operator managing one
 * secret manages it well and an operator managing forty rotates none of them.
 * Purpose is in the label so an audit key and a conversation key never collide,
 * and both are versioned so a derivation can change without silently producing
 * values that verify against the old scheme.
 */
export function tenantKey(rootKey: string, purpose: KeyPurpose, tenantId: string): Buffer {
  if (rootKey === "") throw new Error("a root key is required; there is no unkeyed mode");
  return createHmac("sha256", rootKey).update(`portal.${purpose}:${tenantId}`, "utf8").digest();
}

/**
 * Signs a value, independent of key insertion order.
 *
 * Canonicalised first for the same reason the audit digest is: JSON round trips
 * through a browser and back, and two serialisations of one conversation must
 * agree or every second turn fails.
 */
export function signValue(value: unknown, key: Buffer): string {
  return createHmac("sha256", key).update(canonicalValue(value), "utf8").digest("hex");
}

/**
 * Constant-time, and false rather than throwing on a malformed signature.
 *
 * A caller checking this is deciding whether to trust input; handing it an
 * exception for a wrong-length hex string would make the failure path noisier
 * than the success path, which is its own small oracle.
 */
export function verifyValue(value: unknown, signature: string, key: Buffer): boolean {
  const expected = Buffer.from(signValue(value, key), "utf8");
  const actual = Buffer.from(signature, "utf8");
  // Length first: `timingSafeEqual` throws on a mismatch, and that throw is
  // itself a signal about the length of the expected value.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
