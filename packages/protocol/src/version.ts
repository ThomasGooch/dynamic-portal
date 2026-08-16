/**
 * Portal UI Protocol versioning.
 *
 * The protocol is expected to outlive several generations of renderer, model,
 * and transport, so its compatibility rule is deliberately conservative and
 * written down here rather than implied by behaviour:
 *
 *   - Within a major, the catalog is additive-only. A satellite on a *newer*
 *     minor than the hub is supported; unknown components degrade visibly.
 *   - Across majors, the hub supports the current major and the two preceding
 *     it, giving satellite teams a migration window measured in quarters.
 */

import { z } from "zod";

/**
 * 1.1 added optional `params` to an action descriptor, so the MCP gateway can
 * describe a write to an agent. Additive within the major: a satellite still
 * declaring 1.0 validates unchanged and is fully supported.
 */
export const CURRENT_PROTOCOL_VERSION = "1.1";

/** How many majors before the current one remain supported (the "N-2" rule). */
export const MAJOR_SUPPORT_WINDOW = 2;

export interface ProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

/** The wire shape of a protocol version. Exported so schemas can reuse it. */
export const PROTOCOL_VERSION_PATTERN = /^(\d+)\.(\d+)$/;

export class InvalidProtocolVersionError extends Error {
  constructor(readonly value: string) {
    super(`Invalid protocol version ${JSON.stringify(value)}; expected "MAJOR.MINOR"`);
    this.name = "InvalidProtocolVersionError";
  }
}

export function parseProtocolVersion(value: string): ProtocolVersion {
  const match = PROTOCOL_VERSION_PATTERN.exec(value);
  if (!match) throw new InvalidProtocolVersionError(value);
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * Parsed once at module load. Doing it per call would both repeat the work and
 * put a throwing expression inside a function documented as total — a typo in
 * the constant would surface as a runtime throw from `isSupportedProtocolVersion`
 * instead of failing the moment the module is imported.
 */
const CURRENT_MAJOR = parseProtocolVersion(CURRENT_PROTOCOL_VERSION).major;

/**
 * The `protocol` field of every envelope and manifest.
 *
 * Well-formedness only: whether a *valid* version is still inside the support
 * window is policy the caller applies with `isSupportedProtocolVersion`, so a
 * hub can answer "upgrade your satellite" rather than "your JSON is malformed".
 * Without this, `z.string().min(1)` accepted `"banana"` and the mistake only
 * surfaced far downstream.
 */
export const ProtocolVersionSchema = z
  .string()
  .regex(PROTOCOL_VERSION_PATTERN, 'protocol must be "MAJOR.MINOR", e.g. "1.0"');

/** Pure policy: is `major` inside the support window around `currentMajor`? */
export function isMajorWithinSupportWindow(major: number, currentMajor: number): boolean {
  if (major > currentMajor) return false;
  return major >= currentMajor - MAJOR_SUPPORT_WINDOW;
}

/**
 * Total function over untrusted input — a satellite declaring a nonsense
 * version is unsupported, not an exception at the call site.
 */
export function isSupportedProtocolVersion(value: string): boolean {
  let parsed: ProtocolVersion;
  try {
    parsed = parseProtocolVersion(value);
  } catch {
    return false;
  }
  return isMajorWithinSupportWindow(parsed.major, CURRENT_MAJOR);
}
