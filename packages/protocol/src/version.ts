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

export const CURRENT_PROTOCOL_VERSION = "1.0";

/** How many majors before the current one remain supported (the "N-2" rule). */
export const MAJOR_SUPPORT_WINDOW = 2;

export interface ProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

const VERSION_PATTERN = /^(\d+)\.(\d+)$/;

export class InvalidProtocolVersionError extends Error {
  constructor(readonly value: string) {
    super(`Invalid protocol version ${JSON.stringify(value)}; expected "MAJOR.MINOR"`);
    this.name = "InvalidProtocolVersionError";
  }
}

export function parseProtocolVersion(value: string): ProtocolVersion {
  const match = VERSION_PATTERN.exec(value);
  if (!match) throw new InvalidProtocolVersionError(value);
  return { major: Number(match[1]), minor: Number(match[2]) };
}

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
  const { major: currentMajor } = parseProtocolVersion(CURRENT_PROTOCOL_VERSION);
  return isMajorWithinSupportWindow(parsed.major, currentMajor);
}
