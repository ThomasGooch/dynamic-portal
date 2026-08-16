import { describe, expect, it } from "vitest";
import { ManifestSchema } from "./manifest.js";

const validManifest = {
  protocol: "1.0",
  satelliteId: "orders",
  displayName: "Order Management",
  screens: [{ id: "orders.list", title: "Orders" }],
  actions: [{ id: "orders.approve", title: "Approve order" }],
};

describe("Manifest", () => {
  it("accepts a minimal well-formed manifest", () => {
    expect(() => ManifestSchema.parse(validManifest)).not.toThrow();
  });

  describe("audience — default deny", () => {
    // The single most security-relevant default in the protocol. A satellite
    // that forgets to declare an audience must never become externally
    // visible; silence means internal-only.
    it("defaults an omitted satellite audience to internal-only", () => {
      const parsed = ManifestSchema.parse(validManifest);
      expect(parsed.audience).toEqual(["internal"]);
    });

    it("defaults an omitted screen audience to internal-only", () => {
      const parsed = ManifestSchema.parse(validManifest);
      expect(parsed.screens[0]?.audience).toEqual(["internal"]);
    });

    it("defaults an omitted action audience to internal-only", () => {
      const parsed = ManifestSchema.parse(validManifest);
      expect(parsed.actions[0]?.audience).toEqual(["internal"]);
    });

    it("honours an explicit external audience", () => {
      const parsed = ManifestSchema.parse({
        ...validManifest,
        audience: ["internal", "external"],
      });
      expect(parsed.audience).toEqual(["internal", "external"]);
    });

    it("rejects an unknown audience value", () => {
      expect(() =>
        ManifestSchema.parse({ ...validManifest, audience: ["partner"] }),
      ).toThrow();
    });

    it("rejects an empty audience — silence must be spelled as internal", () => {
      expect(() =>
        ManifestSchema.parse({ ...validManifest, audience: [] }),
      ).toThrow();
    });
  });

  describe("contract integrity", () => {
    it("rejects unknown top-level fields so the contract cannot drift silently", () => {
      expect(() =>
        ManifestSchema.parse({ ...validManifest, extraneous: true }),
      ).toThrow();
    });

    it.each(["protocol", "satelliteId", "displayName", "screens", "actions"])(
      "requires %s",
      (field) => {
        const incomplete: Record<string, unknown> = { ...validManifest };
        delete incomplete[field];
        expect(() => ManifestSchema.parse(incomplete)).toThrow();
      },
    );

    it("rejects duplicate screen ids", () => {
      expect(() =>
        ManifestSchema.parse({
          ...validManifest,
          screens: [{ id: "dup", title: "A" }, { id: "dup", title: "B" }],
        }),
      ).toThrow();
    });

    it("rejects duplicate action ids", () => {
      expect(() =>
        ManifestSchema.parse({
          ...validManifest,
          actions: [{ id: "dup" }, { id: "dup" }],
        }),
      ).toThrow();
    });
  });

  describe("optional capability declarations", () => {
    it("accepts an mcpUrl when the satellite serves MCP natively", () => {
      const parsed = ManifestSchema.parse({
        ...validManifest,
        mcpUrl: "http://localhost:4001/mcp",
      });
      expect(parsed.mcpUrl).toBe("http://localhost:4001/mcp");
    });

    it("leaves mcpUrl undefined so the hub knows to generate a shim", () => {
      expect(ManifestSchema.parse(validManifest).mcpUrl).toBeUndefined();
    });

    it("rejects a non-URL mcpUrl", () => {
      expect(() =>
        ManifestSchema.parse({ ...validManifest, mcpUrl: "not a url" }),
      ).toThrow();
    });
  });
});
