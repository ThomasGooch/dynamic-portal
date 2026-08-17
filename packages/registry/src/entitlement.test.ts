import type { Principal } from "@portal/identity";
import type { Audience } from "@portal/protocol";
import { describe, expect, it } from "vitest";
import { SatelliteSchema } from "./registry";
import { entitle, toolPolicy } from "./entitlement";

const principal = (over: Partial<Principal> = {}): Principal => ({
  sub: "someone@acme.example",
  tenantId: "acme",
  audience: "internal",
  scopes: ["orders.read", "orders.write"],
  ...over,
});

const layer = (audience: Audience[], rbacScopes: string[] = []) => ({ audience, rbacScopes });

describe("narrowing", () => {
  it("takes the intersection of every layer's audience", () => {
    // The rule that has been missed six times in this repository, in six
    // different files. It is a function now, so a seventh projection cannot be
    // written without it.
    const result = entitle(principal(), [
      layer(["internal", "external"]),
      layer(["internal"]),
    ]);
    expect(result.audience).toEqual(["internal"]);
  });

  it("keeps an audience every layer agrees on", () => {
    const result = entitle(principal({ audience: "external" }), [
      layer(["internal", "external"]),
      layer(["internal", "external"]),
    ]);
    expect(result.audience).toEqual(["internal", "external"]);
    expect(result.allowed).toBe(true);
  });

  it("cannot be widened by an inner layer", () => {
    // A screen marked external inside an internal-only satellite is the exact
    // shape of the gateway bug: the inner declaration is not an override.
    const result = entitle(principal({ audience: "external" }), [
      layer(["internal"]),
      layer(["external"]),
    ]);
    expect(result.audience).toEqual([]);
    expect(result.allowed).toBe(false);
  });

  it("refuses when the layers agree on nobody", () => {
    const result = entitle(principal(), [layer(["internal"]), layer(["external"])]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no audience/i);
  });

  it("ignores a layer that is not there, rather than making callers branch", () => {
    // A registry tool policy is optional at every call site. Accepting the
    // absence here is what keeps the "or nothing" branch from being restated
    // once per projection — which is how this rule got lost six times.
    const result = entitle(principal(), [layer(["internal", "external"]), undefined]);
    expect(result.audience).toEqual(["internal", "external"]);
    expect(result.allowed).toBe(true);
  });

  it("deduplicates, because nothing rejects [internal, internal]", () => {
    // `AudienceListSchema` checks membership and non-emptiness, not uniqueness,
    // and the result is serialised into an MCP tool descriptor.
    const result = entitle(principal(), [layer(["internal", "internal"])]);
    expect(result.audience).toEqual(["internal"]);
  });

  it("preserves the order of the outermost layer, so output is stable", () => {
    const result = entitle(principal(), [
      layer(["internal", "external"]),
      layer(["external", "internal"]),
    ]);
    expect(result.audience).toEqual(["internal", "external"]);
  });
});

describe("accumulating scopes", () => {
  it("unions every layer's scopes, because each adds a requirement", () => {
    // Union, never override: an inner policy adds a demand, it does not relieve
    // the caller of an outer one.
    const result = entitle(principal(), [
      layer(["internal"], ["orders.read"]),
      layer(["internal"], ["orders.write"]),
    ]);
    expect([...result.rbacScopes].sort()).toEqual(["orders.read", "orders.write"]);
    expect(result.allowed).toBe(true);
  });

  it("refuses a principal missing any one of them", () => {
    const result = entitle(principal({ scopes: ["orders.read"] }), [
      layer(["internal"], ["orders.read"]),
      layer(["internal"], ["orders.write"]),
    ]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/orders\.write/);
  });

  it("does not repeat a scope two layers both demand", () => {
    const result = entitle(principal(), [
      layer(["internal"], ["orders.read"]),
      layer(["internal"], ["orders.read"]),
    ]);
    expect(result.rbacScopes).toEqual(["orders.read"]);
  });

  it("treats a layer with no scopes as adding none, not as clearing them", () => {
    const result = entitle(principal({ scopes: [] }), [
      layer(["internal"], ["orders.read"]),
      layer(["internal"]),
    ]);
    expect(result.allowed).toBe(false);
  });
});

describe("the principal still has to qualify", () => {
  it("refuses a principal from an audience the layers did not agree on", () => {
    expect(entitle(principal({ audience: "external" }), [layer(["internal"])]).allowed).toBe(false);
  });

  it("reports the audience refusal without naming a scope", () => {
    // The denial reason is a side channel, however small: a caller from the
    // wrong audience learns nothing about what a resource requires.
    const result = entitle(principal({ audience: "external", scopes: [] }), [
      layer(["internal"], ["orders.read"]),
    ]);
    expect(result.allowed).toBe(false);
    expect(result.reason).not.toContain("orders.read");
  });

  it("allows a principal who satisfies every layer", () => {
    expect(
      entitle(principal(), [
        layer(["internal", "external"], ["orders.read"]),
        layer(["internal"], ["orders.write"]),
      ]).allowed,
    ).toBe(true);
  });

  it("handles a single layer, which is the common case", () => {
    expect(entitle(principal(), [layer(["internal"], ["orders.read"])]).allowed).toBe(true);
  });

  it("refuses when given no layers at all, rather than allowing everything", () => {
    // An empty layer list describes nothing, and the safe reading of nothing is
    // not "everyone".
    expect(entitle(principal(), []).allowed).toBe(false);
  });
});

describe("toolPolicy", () => {
  const satellite = SatelliteSchema.parse({
    id: "orders",
    displayName: "Orders",
    baseUrl: "http://localhost:4001",
    owner: "team",
    tools: { "orders.approve": { rbacScopes: ["orders.write"] } },
  });

  it("finds a declared policy", () => {
    expect(toolPolicy(satellite, "orders.approve")?.rbacScopes).toEqual(["orders.write"]);
  });

  it("returns nothing for an id with no policy", () => {
    expect(toolPolicy(satellite, "orders.list")).toBeUndefined();
  });

  it("does not read a policy off the prototype chain", () => {
    // `constructor` is a legal id and `tools` is a plain object, so bare bracket
    // access resolves to the `Object` function — whose `rbacScopes` is
    // undefined, which reads as "no scopes required" exactly where that is
    // worst. Fixed twice already, in two different files, before it was a
    // function.
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(toolPolicy(satellite, name), name).toBeUndefined();
    }
  });
});
