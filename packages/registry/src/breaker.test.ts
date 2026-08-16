import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "./breaker.js";

/**
 * Time is injected rather than mocked globally. A breaker whose tests depend on
 * real elapsed time is either slow or flaky, and usually both.
 */
const at = (t: number) => () => t;

describe("CircuitBreaker", () => {
  it("starts closed", () => {
    expect(new CircuitBreaker({ now: at(0) }).state).toBe("closed");
  });

  it("stays closed while failures are below the threshold", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, now: at(0) });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe("closed");
    expect(breaker.allowsRequest()).toBe(true);
  });

  it("opens once the threshold is reached", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, now: at(0) });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe("open");
    expect(breaker.allowsRequest()).toBe(false);
  });

  it("a success resets the count, so intermittent failures do not accumulate forever", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, now: at(0) });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.state).toBe("closed");
  });

  it("half-opens after the cooldown and allows exactly one trial request", () => {
    let clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1000,
      now: () => clock,
    });
    breaker.recordFailure();
    expect(breaker.allowsRequest()).toBe(false);

    clock = 1000;
    expect(breaker.allowsRequest()).toBe(true);
    expect(breaker.state).toBe("half-open");
    // A second caller must not also be let through — the point of half-open is
    // one probe, not a thundering herd at the satellite that just recovered.
    expect(breaker.allowsRequest()).toBe(false);
  });

  it("closes when the trial request succeeds", () => {
    let clock = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => clock });
    breaker.recordFailure();
    clock = 100;
    breaker.allowsRequest();
    breaker.recordSuccess();
    expect(breaker.state).toBe("closed");
    expect(breaker.allowsRequest()).toBe(true);
  });

  it("re-opens when the trial request fails, and waits the cooldown again", () => {
    let clock = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => clock });
    breaker.recordFailure();
    clock = 100;
    breaker.allowsRequest();
    breaker.recordFailure();
    expect(breaker.state).toBe("open");
    expect(breaker.allowsRequest()).toBe(false);

    clock = 200;
    expect(breaker.allowsRequest()).toBe(true);
  });

  it("reports when it will next allow a request, so a caller can say so", () => {
    let clock = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 5000, now: () => clock });
    breaker.recordFailure();
    expect(breaker.retryAfterMs()).toBe(5000);
    clock = 2000;
    expect(breaker.retryAfterMs()).toBe(3000);
  });

  it("reports zero retry time while closed", () => {
    expect(new CircuitBreaker({ now: at(0) }).retryAfterMs()).toBe(0);
  });

  it("does not let stragglers push the cooldown out", () => {
    // The requests that were already in flight when the circuit tripped fail
    // one after another. Restarting the cooldown on each of them would delay
    // recovery by the length of the in-flight tail rather than by the cooldown
    // the operator configured.
    let clock = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => clock });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe("open");

    clock = 500;
    breaker.recordFailure();
    expect(breaker.retryAfterMs()).toBe(500);

    clock = 1000;
    expect(breaker.allowsRequest()).toBe(true);
  });

  it("expires a probe whose outcome is never reported", () => {
    // A caller that throws before recording — or abandons the request — would
    // otherwise leave the breaker half-open forever, refusing every request for
    // the life of the process. Nothing else can move it: half-open has no
    // timer of its own.
    let clock = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => clock });
    breaker.recordFailure();
    clock = 1000;
    expect(breaker.allowsRequest()).toBe(true);
    expect(breaker.state).toBe("half-open");

    clock = 2000;
    expect(breaker.allowsRequest()).toBe(true);
  });

  it("reports a wait while a probe is outstanding rather than zero", () => {
    // Half-open refuses everyone but the probe, so a zero here becomes
    // `Retry-After: 0` and the herd half-open exists to prevent.
    let clock = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => clock });
    breaker.recordFailure();
    clock = 1000;
    breaker.allowsRequest();
    expect(breaker.allowsRequest()).toBe(false);
    expect(breaker.retryAfterMs()).toBeGreaterThan(0);
  });
});
