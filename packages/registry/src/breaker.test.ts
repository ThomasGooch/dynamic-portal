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
});
