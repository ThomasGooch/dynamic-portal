import { describe, expect, it } from "vitest";
import { ActionResponseSchema, ScreenResponseSchema } from "./envelopes";
import { MAX_NODE_DEPTH, UiNodeSchema } from "./node";

describe("UiNode", () => {
  // The protocol deliberately does NOT know the component catalog. It validates
  // that a node is structurally a node; the catalog validates that the node is a
  // legal component. That separation is what lets the catalog evolve on a faster
  // clock than the protocol without a coordinated release.
  it("accepts any typed node with children", () => {
    expect(() =>
      UiNodeSchema.parse({
        type: "Page",
        children: [{ type: "Heading", props: { text: "Hi" } }],
      }),
    ).not.toThrow();
  });

  it("accepts a component type the protocol has never heard of", () => {
    expect(() =>
      UiNodeSchema.parse({ type: "SomeFutureComponent" }),
    ).not.toThrow();
  });

  it("requires a type discriminant", () => {
    expect(() => UiNodeSchema.parse({ props: {} })).toThrow();
  });

  it("rejects a raw-HTML escape hatch at the protocol layer", () => {
    // Belt-and-braces: the catalog forbids these too, but a satellite must not
    // be able to smuggle markup past a hub that only ran protocol validation.
    expect(() =>
      UiNodeSchema.parse({ type: "Text", props: { dangerouslySetInnerHTML: "<b>x</b>" } }),
    ).toThrow();
    expect(() =>
      UiNodeSchema.parse({ type: "Text", props: { className: "p-4" } }),
    ).toThrow();
    expect(() =>
      UiNodeSchema.parse({ type: "Text", props: { style: { color: "red" } } }),
    ).toThrow();
  });

  const nest = (levels: number): unknown => {
    let node: unknown = { type: "Text" };
    for (let i = 1; i < levels; i += 1) node = { type: "Stack", children: [node] };
    return node;
  };

  it("nests as deep as any real screen needs", () => {
    expect(() => UiNodeSchema.parse(nest(MAX_NODE_DEPTH))).not.toThrow();
  });

  it("rejects a tree deeper than the bound instead of overflowing the stack", () => {
    // Zod recurses to validate a recursive schema, so an unbounded tree used to
    // raise a RangeError — not a ZodError — around 1.5k levels, which a hub
    // catching ZodError would turn into a 500.
    const result = UiNodeSchema.safeParse(nest(5_000));
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.message).toMatch(/nests deeper/);
  });

  it("rejects a repeated node id — a patch could not tell the two apart", () => {
    expect(() =>
      UiNodeSchema.parse({
        type: "Page",
        children: [
          { type: "Table", id: "orders-table" },
          { type: "Table", id: "orders-table" },
        ],
      }),
    ).toThrow(/duplicate node id/);
  });
});

describe("ScreenResponse", () => {
  const valid = {
    protocol: "1.0",
    screen: { id: "orders.list", title: "Orders" },
    ui: { type: "Page", children: [] },
  };

  it("accepts a well-formed screen response", () => {
    expect(() => ScreenResponseSchema.parse(valid)).not.toThrow();
  });

  it("requires protocol, screen, and ui", () => {
    for (const field of ["protocol", "screen", "ui"]) {
      const incomplete: Record<string, unknown> = { ...valid };
      delete incomplete[field];
      expect(() => ScreenResponseSchema.parse(incomplete)).toThrow();
    }
  });

  it("carries optional cache metadata", () => {
    const parsed = ScreenResponseSchema.parse({
      ...valid,
      meta: { ttlSeconds: 30, etag: "abc" },
    });
    expect(parsed.meta?.ttlSeconds).toBe(30);
  });

  it("rejects a negative ttl", () => {
    expect(() =>
      ScreenResponseSchema.parse({ ...valid, meta: { ttlSeconds: -1 } }),
    ).toThrow();
  });

  it("rejects a malformed protocol version", () => {
    expect(() => ScreenResponseSchema.parse({ ...valid, protocol: "banana" })).toThrow();
  });

  it("rejects a breadcrumb whose screenId is empty rather than absent", () => {
    // An empty string is a crumb that reads as navigable to a hub testing for
    // presence, but links nowhere.
    expect(() =>
      ScreenResponseSchema.parse({
        ...valid,
        screen: { id: "orders.detail", title: "Order", breadcrumbs: [{ label: "Orders", screenId: "" }] },
      }),
    ).toThrow();
  });
});

describe("ActionResponse", () => {
  it("accepts a bare success", () => {
    expect(() =>
      ActionResponseSchema.parse({ protocol: "1.0", outcome: "ok" }),
    ).not.toThrow();
  });

  it("accepts a success carrying a toast and a patch", () => {
    expect(() =>
      ActionResponseSchema.parse({
        protocol: "1.0",
        outcome: "ok",
        toast: { level: "success", message: "Order approved" },
        patch: [{ targetId: "orders-table", ui: { type: "Table" } }],
      }),
    ).not.toThrow();
  });

  it("accepts a validation failure carrying field errors", () => {
    expect(() =>
      ActionResponseSchema.parse({
        protocol: "1.0",
        outcome: "validation",
        fieldErrors: { email: "Already in use" },
      }),
    ).not.toThrow();
  });

  describe("outcome coherence", () => {
    // These constraints exist so a satellite cannot return a response the hub
    // would have to guess how to render.
    it("rejects fieldErrors on a successful outcome", () => {
      expect(() =>
        ActionResponseSchema.parse({
          protocol: "1.0",
          outcome: "ok",
          fieldErrors: { email: "nope" },
        }),
      ).toThrow();
    });

    it("requires a validation outcome to actually carry field errors", () => {
      expect(() =>
        ActionResponseSchema.parse({ protocol: "1.0", outcome: "validation" }),
      ).toThrow();
    });

    it("rejects an empty fieldErrors map on a validation outcome", () => {
      expect(() =>
        ActionResponseSchema.parse({
          protocol: "1.0",
          outcome: "validation",
          fieldErrors: {},
        }),
      ).toThrow();
    });

    it("rejects a patch on an error outcome — nothing changed", () => {
      expect(() =>
        ActionResponseSchema.parse({
          protocol: "1.0",
          outcome: "error",
          patch: [{ targetId: "x", ui: { type: "Text" } }],
        }),
      ).toThrow();
    });
  });

  it("rejects an unknown outcome", () => {
    expect(() =>
      ActionResponseSchema.parse({ protocol: "1.0", outcome: "maybe" }),
    ).toThrow();
  });

  it("rejects unknown top-level fields", () => {
    expect(() =>
      ActionResponseSchema.parse({ protocol: "1.0", outcome: "ok", surprise: 1 }),
    ).toThrow();
  });
});
