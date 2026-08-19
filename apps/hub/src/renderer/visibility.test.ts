import { describe, expect, it } from "vitest";
import { isVisible, type VisibleWhen } from "./visibility";

/**
 * The rules a form's conditions have to obey, asked without a browser.
 *
 * The interesting cases here are the ones a screenshot cannot show: a rule
 * pointing at a field that is itself hidden, a rule pointing at a field nobody
 * declared, a rule pointing into half a `DateRange`.
 */

const form = (...names: string[]): ReadonlySet<string> => new Set(names);

describe("isVisible", () => {
  it("shows a field that declares no condition", () => {
    expect(isVisible(undefined, {}, form())).toBe(true);
  });

  it("compares equality against the value the field currently holds", () => {
    const rule: VisibleWhen = { field: "expedited", equals: true };
    expect(isVisible(rule, { expedited: true }, form("expedited"))).toBe(true);
    expect(isVisible(rule, { expedited: false }, form("expedited"))).toBe(false);
  });

  it("reads membership on a multi-select as *includes*, not equals", () => {
    const rule: VisibleWhen = { field: "tags", oneOf: ["hazmat"] };
    expect(isVisible(rule, { tags: ["retail", "hazmat"] }, form("tags"))).toBe(true);
    expect(isVisible(rule, { tags: ["retail"] }, form("tags"))).toBe(false);
    expect(isVisible(rule, { tags: [] }, form("tags"))).toBe(false);
  });

  it("reads membership on a single-valued field as the value itself", () => {
    const rule: VisibleWhen = { field: "priority", oneOf: ["express", "critical"] };
    expect(isVisible(rule, { priority: "express" }, form("priority"))).toBe(true);
    expect(isVisible(rule, { priority: "standard" }, form("priority"))).toBe(false);
  });

  it("does not match an unanswered radio group against a membership rule", () => {
    // Collected as null rather than dropped, so this has to say no rather than
    // fall through to the "no such field" branch and show the control.
    const rule: VisibleWhen = { field: "priority", oneOf: ["express"] };
    expect(isVisible(rule, { priority: null }, form("priority"))).toBe(false);
  });

  it("hides a field whose condition names a field that is itself hidden", () => {
    // The chain: `approver` depends on `reason`, which is not on the screen
    // because its own condition is unmet — so its value is not in `values`.
    // Showing `approver` here would show it *and submit it* at exactly the
    // moment its condition cannot possibly hold.
    const rule: VisibleWhen = { field: "reason", equals: "finance" };
    expect(isVisible(rule, { expedited: false }, form("expedited", "reason"))).toBe(false);
  });

  it("shows a field whose condition names no field on this form", () => {
    // A typo in a satellite. Hiding the control reads as a missing feature and
    // is unrecoverable from the browser; showing it is a visible bug, and the
    // satellite still refuses whatever it receives.
    const rule: VisibleWhen = { field: "feild", equals: "x" };
    expect(isVisible(rule, { field: "x" }, form("field"))).toBe(true);
  });

  it("reaches into half a DateRange, which is collected as a nested pair", () => {
    const rule: VisibleWhen = { field: "window.from", equals: "2026-01-01" };
    const declared = form("window");
    expect(isVisible(rule, { window: { from: "2026-01-01", to: "" } }, declared)).toBe(true);
    expect(isVisible(rule, { window: { from: "", to: "" } }, declared)).toBe(false);
    // Declared but not drawn: the range is hidden, so anything reading it is.
    expect(isVisible(rule, {}, declared)).toBe(false);
  });

  it("does not mistake a prototype property for a declared field", () => {
    const rule: VisibleWhen = { field: "toString", equals: "x" };
    expect(isVisible(rule, {}, form("toString"))).toBe(false);
    expect(isVisible(rule, {}, form())).toBe(true);
  });

  it("settles rather than flickers when two fields name each other", () => {
    // Hiding only ever propagates into more hiding, which is what makes a cycle
    // reach an answer instead of oscillating between two.
    const a: VisibleWhen = { field: "b", equals: "yes" };
    const b: VisibleWhen = { field: "a", equals: "yes" };
    const declared = form("a", "b");

    // Both drawn and neither answered: each hides on the other's value.
    expect(isVisible(a, { a: "", b: "" }, declared)).toBe(false);
    expect(isVisible(b, { a: "", b: "" }, declared)).toBe(false);
    // Once gone, they stay gone — the next pass reads no value at all.
    expect(isVisible(a, {}, declared)).toBe(false);
    expect(isVisible(b, {}, declared)).toBe(false);
  });
});
