import { describe, expect, it } from "vitest";
import { BRANDS, brandAttributes, resolveBrand } from "./brand";

/**
 * The env-to-attribute step, which is the half of the brand feature the e2e
 * suite cannot assert.
 *
 * Playwright can swap `data-brand` in the browser and prove the stylesheet
 * holds two palettes, but it can only observe the attribute the *running* stack
 * happened to render — and that stack has no brand set, so the interesting
 * paths are the ones it never takes. They are all here instead, where the
 * environment is an argument.
 */
describe("PORTAL_BRAND", () => {
  it("is absent when unset, so a portal with no brand looks like the portal", () => {
    expect(resolveBrand({})).toBeUndefined();
  });

  it("treats empty and whitespace as unset, because compose writes `${VAR:-}`", () => {
    // Every optional setting arrives as "" rather than undefined from the
    // compose stack, and a trailing space in a `.env` file is not a typo
    // anyone can see.
    expect(resolveBrand({ PORTAL_BRAND: "" })).toBeUndefined();
    expect(resolveBrand({ PORTAL_BRAND: "   " })).toBeUndefined();
  });

  it.each(BRANDS)("accepts %s, the palette the stylesheet defines", (brand) => {
    expect(resolveBrand({ PORTAL_BRAND: brand })).toBe(brand);
  });

  it("trims, so a stray space in a .env file is not a silent default", () => {
    expect(resolveBrand({ PORTAL_BRAND: " contoso " })).toBe("contoso");
  });

  it("refuses a name no palette answers to, rather than serving the default", () => {
    // The failure this prevents: an unmatched attribute selects nothing, so
    // the page renders correctly in the wrong palette and the only symptom is
    // a rebrand that did not happen.
    expect(() => resolveBrand({ PORTAL_BRAND: "fabrikam" })).toThrow(/not a brand/);
  });

  it("refuses a known name in the wrong case, because CSS would too", () => {
    // Attribute values in selectors are case-sensitive in HTML documents, so
    // `Contoso` matches no rule. Accepting it here would put a value in the
    // DOM that the stylesheet ignores.
    expect(() => resolveBrand({ PORTAL_BRAND: "Contoso" })).toThrow(/not a brand/);
  });

  it("names the brands it does accept, so the fix is in the error", () => {
    expect(() => resolveBrand({ PORTAL_BRAND: "fabrikam" })).toThrow(/"contoso"/);
  });

  it("spreads to no attribute at all when unset, never `data-brand=\"\"`", () => {
    // An empty value is something CSS can match on, which would be one more
    // way to select nothing.
    expect(brandAttributes({})).toEqual({});
  });

  it("spreads to the attribute the stylesheet keys on", () => {
    expect(brandAttributes({ PORTAL_BRAND: "contoso" })).toEqual({ "data-brand": "contoso" });
  });
});
