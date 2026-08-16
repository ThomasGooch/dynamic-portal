/**
 * Per-satellite circuit breaker.
 *
 * A satellite that is down, slow, or returning garbage must degrade to a scoped
 * error card while nav and every other satellite keep working. Without a
 * breaker, an unwell satellite is retried on every request — turning one
 * team's incident into portal-wide latency.
 *
 * `now` is injected because a breaker whose tests depend on real elapsed time is
 * either slow or flaky, and usually both.
 */

export type BreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. */
  readonly failureThreshold?: number;
  /** How long to stay open before allowing one trial request. */
  readonly cooldownMs?: number;
  readonly now?: () => number;
}

export class CircuitBreaker {
  readonly #failureThreshold: number;
  readonly #cooldownMs: number;
  readonly #now: () => number;

  #failures = 0;
  #openedAt = 0;
  #state: BreakerState = "closed";
  /** True once half-open has handed out its single probe. */
  #probeInFlight = false;
  /** When that probe was handed out, so an unreported one can expire. */
  #probeStartedAt = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    this.#failureThreshold = options.failureThreshold ?? 5;
    this.#cooldownMs = options.cooldownMs ?? 30_000;
    this.#now = options.now ?? Date.now;
  }

  get state(): BreakerState {
    return this.#state;
  }

  /**
   * Whether to attempt a call — and, as a side effect, the transition from
   * open to half-open once the cooldown has elapsed.
   */
  allowsRequest(): boolean {
    if (this.#state === "closed") return true;

    if (this.#state === "open") {
      if (this.#now() - this.#openedAt < this.#cooldownMs) return false;
      this.#state = "half-open";
      this.#probeInFlight = true;
      this.#probeStartedAt = this.#now();
      return true;
    }

    // Half-open lets exactly one request through. The point is a single probe,
    // not a thundering herd at a satellite that has only just recovered.
    //
    // The probe expires after a cooldown, because a caller that throws before
    // recording an outcome — or abandons the request — would otherwise leave
    // `probeInFlight` set forever, wedging the breaker half-open and refusing
    // every request for the rest of the process's life.
    if (this.#probeInFlight && this.#now() - this.#probeStartedAt < this.#cooldownMs) {
      return false;
    }
    this.#probeInFlight = true;
    this.#probeStartedAt = this.#now();
    return true;
  }

  recordSuccess(): void {
    this.#failures = 0;
    this.#state = "closed";
    this.#probeInFlight = false;
  }

  recordFailure(): void {
    // A failure reported while the circuit is already open belongs to a request
    // that was in flight when it tripped. Counting it would push `openedAt`
    // forward on every straggler, delaying half-open by the length of the
    // in-flight tail rather than by the cooldown that was configured.
    if (this.#state === "open") return;

    this.#probeInFlight = false;

    // A failed probe returns to open and waits the full cooldown again, rather
    // than retrying immediately.
    if (this.#state === "half-open") {
      this.#state = "open";
      this.#openedAt = this.#now();
      return;
    }

    this.#failures += 1;
    if (this.#failures >= this.#failureThreshold) {
      this.#state = "open";
      this.#openedAt = this.#now();
    }
  }

  /** Milliseconds until the next request would be allowed; 0 when one is allowed now. */
  retryAfterMs(): number {
    if (this.#state === "open") {
      return Math.max(0, this.#cooldownMs - (this.#now() - this.#openedAt));
    }
    // Half-open with a probe outstanding refuses requests too. Reporting 0 there
    // tells the caller — and, via Retry-After, the browser — to try again
    // immediately, which is precisely the herd half-open exists to prevent.
    if (this.#state === "half-open" && this.#probeInFlight) {
      return Math.max(0, this.#cooldownMs - (this.#now() - this.#probeStartedAt));
    }
    return 0;
  }
}
