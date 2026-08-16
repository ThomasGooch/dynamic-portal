import { describe, expect, it } from "vitest";
import { ManifestSchema } from "./manifest";

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

    it("refuses a screen reaching wider than the satellite that declares it", () => {
      // Otherwise a projection filtering on the screen's own audience — the
      // natural reading — publishes a screen from an internal-only satellite.
      expect(() =>
        ManifestSchema.parse({
          ...validManifest,
          audience: ["internal"],
          screens: [{ id: "orders.list", title: "Orders", audience: ["external"] }],
        }),
      ).toThrow(/audience the satellite does not/);
    });

    it("refuses an action reaching wider than the satellite that declares it", () => {
      expect(() =>
        ManifestSchema.parse({
          ...validManifest,
          audience: ["internal"],
          actions: [{ id: "orders.approve", audience: ["external"] }],
        }),
      ).toThrow(/audience the satellite does not/);
    });

    it("allows an external screen once the satellite declares external", () => {
      expect(() =>
        ManifestSchema.parse({
          ...validManifest,
          audience: ["internal", "external"],
          screens: [{ id: "orders.list", title: "Orders", audience: ["external"] }],
        }),
      ).not.toThrow();
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

    it("rejects duplicate screen param names", () => {
      // Two params with one name means the hub renders two inputs and the last
      // value silently wins.
      expect(() =>
        ManifestSchema.parse({
          ...validManifest,
          screens: [
            { id: "orders.list", title: "Orders", params: [{ name: "id" }, { name: "id" }] },
          ],
        }),
      ).toThrow(/duplicate param name/);
    });

    it("rejects a malformed protocol version", () => {
      for (const bad of ["banana", "1", "1.2.3", "v1.0"]) {
        expect(() => ManifestSchema.parse({ ...validManifest, protocol: bad })).toThrow();
      }
    });

    it("rejects a nav entry pointing at a screen that does not exist", () => {
      expect(() =>
        ManifestSchema.parse({
          ...validManifest,
          nav: [{ screenId: "orders.lst", label: "Orders" }],
        }),
      ).toThrow(/unknown screen/);
    });

    it("accepts a nav entry pointing at a declared screen", () => {
      expect(() =>
        ManifestSchema.parse({
          ...validManifest,
          nav: [{ screenId: "orders.list", label: "Orders" }],
        }),
      ).not.toThrow();
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

    it("rejects an mcpUrl that parses but is not fetchable http(s)", () => {
      // `new URL()` accepts all of these, so `z.string().url()` alone let a
      // satellite hand the hub a scheme it should never dereference.
      for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) {
        expect(() => ManifestSchema.parse({ ...validManifest, mcpUrl: bad })).toThrow();
      }
    });

    it("rejects a healthPath that escapes the satellite's own origin", () => {
      // "//evil.example" is protocol-relative: `new URL(path, satelliteBase)`
      // resolves it to a different host, and the hub polls it.
      for (const bad of ["//evil.example", "/\\evil.example"]) {
        expect(() => ManifestSchema.parse({ ...validManifest, healthPath: bad })).toThrow();
      }
      expect(() =>
        ManifestSchema.parse({ ...validManifest, healthPath: "/healthz" }),
      ).not.toThrow();
    });
  });
});
