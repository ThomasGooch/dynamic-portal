/**
 * The settings the hub cannot run without, checked before it accepts anything.
 *
 * PLAN.md says the hub "refuses to serve" without an audit key. That was
 * generous. `auditConfig()` and `getPortal()` are both lazy and memoised, so a
 * hub with no key started, answered `/` — which touches no audited path — and
 * passed compose's healthcheck. `pnpm up` reported the stack healthy. The first
 * screen read then 500'd, and every one after it.
 *
 * A container that passes its own healthcheck and fails every real request is
 * the worst available failure: whatever is watching it says green, and the
 * thing that would have told you is a log nobody has configured yet, because
 * the log is what is missing.
 *
 * Next calls `register` once per server instance. Throwing here makes the
 * server fail to prepare, so every request — including `/`, which touches no
 * audited path and was therefore passing the healthcheck — answers 500, and the
 * container never becomes healthy.
 *
 * Stated that way because it is what was observed rather than what was hoped
 * for: the process does *not* exit, and Next prints "Ready" before it runs
 * this. What changes is that nothing is ever served, and the reason is in the
 * first lines of the log rather than in the five-hundredth request.
 */

/** Named so the failure says what to do, not merely what is absent. */
const REQUIRED: readonly { readonly name: string; readonly why: string }[] = [
  {
    name: "PORTAL_PRINCIPAL_SECRET",
    why: "signs the principal each satellite verifies; defaulting it would let every satellite accept identities the hub never checked",
  },
  {
    name: "PORTAL_AUDIT_KEY",
    why: "the root secret every tenant's audit digest key derives from; there is no unkeyed mode",
  },
  {
    name: "PORTAL_AUDIT_LOG",
    why: "where audit records are appended; every screen read, action and tool call is recorded",
  },
];

export function register(): void {
  // `register` also runs for the edge runtime, which has neither filesystem nor
  // these settings. The hub's routes are all node.
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;

  const missing = REQUIRED.filter(({ name }) => !process.env[name]);
  if (missing.length === 0) return;

  throw new Error(
    [
      `The hub cannot start. ${missing.length} required setting${missing.length === 1 ? " is" : "s are"} not configured:`,
      ...missing.map(({ name, why }) => `  ${name} — ${why}`),
      "",
      "See .env.example. None of these have defaults, deliberately: a default",
      "here is a control that looks present and is not.",
    ].join("\n"),
  );
}
