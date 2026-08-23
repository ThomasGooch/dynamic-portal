import { describe, expect, it } from "vitest";
import { ManifestSchema } from "./manifest";
import { ALL_ROLES, RoleListSchema, RoleSchema, hasAnyRole, isRoleSubset } from "./role";

describe("RoleSchema", () => {
  it("accepts the four org roles", () => {
    for (const role of ["leadership", "engineering", "finance", "platform"]) {
      expect(() => RoleSchema.parse(role)).not.toThrow();
    }
  });

  it("rejects an unknown role", () => {
    expect(() => RoleSchema.parse("admin")).toThrow();
  });

  it("ALL_ROLES is the full, frozen set", () => {
    expect([...ALL_ROLES].sort()).toEqual(
      ["engineering", "finance", "leadership", "platform"].sort(),
    );
    expect(Object.isFrozen(ALL_ROLES)).toBe(true);
  });
});

describe("RoleListSchema — optional, opt-in, never empty", () => {
  it("accepts an absent list (un-gated)", () => {
    expect(RoleListSchema.parse(undefined)).toBeUndefined();
  });

  it("accepts a non-empty list", () => {
    expect(RoleListSchema.parse(["finance"])).toEqual(["finance"]);
  });

  it("rejects an empty list — omit the field instead", () => {
    // Unlike audience, absent is the opt-out, so [] has no coherent meaning
    // anyone would hand-write; the only empty set that means 'nobody' comes
    // from narrowing, never from a declaration.
    expect(() => RoleListSchema.parse([])).toThrow();
  });
});

describe("hasAnyRole — any-of", () => {
  it("is true when the principal holds one of the target roles", () => {
    expect(hasAnyRole(["finance"], ["leadership", "finance"])).toBe(true);
  });

  it("is false when the principal holds none of them", () => {
    expect(hasAnyRole(["engineering"], ["leadership", "finance"])).toBe(false);
  });

  it("is false against an empty target (nobody), matching intersection semantics", () => {
    expect(hasAnyRole(["platform"], [])).toBe(false);
  });
});

describe("isRoleSubset", () => {
  it("is true when every role is present in the superset", () => {
    expect(isRoleSubset(["finance"], ["leadership", "finance"])).toBe(true);
  });

  it("is false when a role is missing from the superset", () => {
    expect(isRoleSubset(["platform"], ["leadership", "finance"])).toBe(false);
  });
});

describe("Manifest — role gating is opt-in and cannot widen the satellite", () => {
  const base = {
    protocol: "1.0",
    satelliteId: "orders",
    displayName: "Order Management",
    screens: [{ id: "orders.list", title: "Orders" }],
    actions: [{ id: "orders.approve", title: "Approve order" }],
  };

  it("leaves roles undefined when nothing declares them (backward compatible)", () => {
    const parsed = ManifestSchema.parse(base);
    expect(parsed.roles).toBeUndefined();
    expect(parsed.screens[0]?.roles).toBeUndefined();
  });

  it("lets a screen name any roles when the satellite declares none (no ceiling)", () => {
    expect(() =>
      ManifestSchema.parse({
        ...base,
        screens: [{ id: "orders.list", title: "Orders", roles: ["finance"] }],
      }),
    ).not.toThrow();
  });

  it("accepts a screen whose roles are within the satellite's declared roles", () => {
    expect(() =>
      ManifestSchema.parse({
        ...base,
        roles: ["leadership", "finance"],
        screens: [{ id: "orders.list", title: "Orders", roles: ["finance"] }],
      }),
    ).not.toThrow();
  });

  it("refuses a screen naming a role the satellite was not granted", () => {
    expect(() =>
      ManifestSchema.parse({
        ...base,
        roles: ["finance"],
        screens: [{ id: "orders.list", title: "Orders", roles: ["platform"] }],
      }),
    ).toThrow(/declares a role the satellite does not/);
  });

  it("refuses an action naming a role the satellite was not granted", () => {
    expect(() =>
      ManifestSchema.parse({
        ...base,
        roles: ["finance"],
        actions: [{ id: "orders.approve", title: "Approve order", roles: ["engineering"] }],
      }),
    ).toThrow(/declares a role the satellite does not/);
  });
});
