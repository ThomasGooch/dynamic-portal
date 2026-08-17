import { validateNested } from "@portal/catalog";
import { CURRENT_PROTOCOL_VERSION } from "@portal/protocol";
import { describe, expect, it } from "vitest";
import { InvalidEnvelopeError, failed, invalid, manifest, ok, screen } from "./envelopes";
import { InvalidNodeError, ui, withId, withSource } from "./ui";

describe("building a node", () => {
  it("produces the shape the protocol expects", () => {
    expect(ui.Text({ text: "Nothing yet." })).toEqual({
      type: "Text",
      props: { text: "Nothing yet." },
    });
  });

  it("nests children only when there are some", () => {
    // An empty `children` array is noise on every leaf in a tree.
    expect(ui.Page({})).not.toHaveProperty("children");
    expect(ui.Page({}, ui.Text({ text: "hi" }))).toHaveProperty("children");
  });

  it("throws where the mistake was written, naming the component", () => {
    // The whole point of the SDK. Without it this is a screen the hub refuses
    // at request time, in an environment the satellite team cannot see.
    expect(() => ui.Text({ text: 42 } as never)).toThrow(InvalidNodeError);
    expect(() => ui.Text({ text: 42 } as never)).toThrow(/Text/);
  });

  it("catches what the compiler cannot", () => {
    // A `Link.href` is a string to TypeScript and an http(s) url to the
    // catalog. Data arriving from anywhere untyped lands here.
    expect(() => ui.Link({ label: "x", href: "javascript:alert(1)" })).toThrow(InvalidNodeError);
  });

  it("refuses a presentation prop rather than letting the hub strip it", () => {
    expect(() => ui.Text({ text: "x", className: "danger" } as never)).toThrow(InvalidNodeError);
  });

  it("covers every component in the catalog", async () => {
    // Derived from the catalog rather than listed, so a component added there
    // gets a builder without anyone remembering.
    const { COMPONENT_NAMES } = await import("@portal/catalog");
    for (const name of COMPONENT_NAMES) {
      expect(typeof ui[name], name).toBe("function");
    }
  });

  it("declares no defaults anywhere in the catalog", async () => {
    // Load-bearing. `build()` returns the caller's props rather than the parse
    // output, to avoid deep-copying every row of a table on every request. That
    // is only equivalent while no component fills anything in — the day one
    // does, a builder would silently stop applying it.
    const { COMPONENTS, COMPONENT_NAMES } = await import("@portal/catalog");
    for (const name of COMPONENT_NAMES) {
      const parsed = COMPONENTS[name].safeParse({});
      // An empty object either fails (required props) or round-trips to an
      // empty object. Anything appearing out of nowhere is a default.
      if (parsed.success) expect(parsed.data, name).toEqual({});
    }
  });

  it("does not copy the data it was handed", () => {
    // A `Table` on a large screen carries thousands of rows; cloning them per
    // request buys nothing, since nothing reads the parsed value.
    const rows = [{ id: "ord-1" }];
    const node = ui.Table({ columns: [{ key: "id", label: "Id" }], rows });
    expect((node.props as { rows: unknown[] }).rows).toBe(rows);
  });

  it("names a node for a patch to address, without touching its props", () => {
    const node = withId("orders-table", ui.Table({ columns: [{ key: "id", label: "Id" }] }));
    expect(node.id).toBe("orders-table");
    expect(node.props).not.toHaveProperty("id");
  });

  it("attaches provenance the same way", () => {
    expect(withSource("call-1", ui.StatTile({ label: "Pending", value: "2" })).source).toEqual({
      toolCallId: "call-1",
    });
  });

  it("builds trees the catalog accepts, which is the only claim that matters", () => {
    const tree = ui.Page(
      { title: "Orders" },
      ui.Section(
        { title: "All orders" },
        withId(
          "orders-table",
          ui.Table({
            columns: [{ key: "id", label: "Order" }],
            rows: [{ id: "ord-1" }],
            emptyMessage: "None yet.",
          }),
        ),
      ),
    );
    expect(validateNested(tree).ok).toBe(true);
  });
});

describe("the screen envelope", () => {
  it("fills in the protocol version so a satellite never copies it wrong", () => {
    const response = screen({ id: "orders.list", title: "Orders", ui: ui.Page({}) });
    expect(response.protocol).toBe(CURRENT_PROTOCOL_VERSION);
  });

  it("carries breadcrumbs and cache hints when given", () => {
    const response = screen({
      id: "orders.detail",
      title: "Order",
      ui: ui.Page({}),
      breadcrumbs: [{ label: "Orders", screenId: "orders.list" }],
      ttlSeconds: 15,
    });
    expect(response.screen.breadcrumbs).toHaveLength(1);
    expect(response.meta?.ttlSeconds).toBe(15);
  });

  it("omits meta entirely rather than sending an empty object", () => {
    expect(screen({ id: "s", title: "T", ui: ui.Page({}) }).meta).toBeUndefined();
  });

  it("refuses a screen the hub would reject", () => {
    expect(() => screen({ id: "", title: "T", ui: ui.Page({}) })).toThrow(InvalidEnvelopeError);
  });

  it("refuses a subtree that never went through a builder", () => {
    // The last way round the SDK: a helper returning `UiNode`, or a literal
    // someone wrote in a hurry. `ScreenResponseSchema` checks the tree is a
    // tree and does not know the component vocabulary, so without the catalog
    // pass this reached the hub and was refused whole.
    expect(() =>
      screen({
        id: "orders.list",
        title: "Orders",
        ui: { type: "Text", props: { txt: "hand written" } },
      }),
    ).toThrow(InvalidEnvelopeError);
  });
});

describe("the action envelope", () => {
  it("builds a success with a message", () => {
    expect(ok({ message: "Order approved." })).toEqual({
      protocol: CURRENT_PROTOCOL_VERSION,
      outcome: "ok",
      toast: { level: "success", message: "Order approved." },
    });
  });

  it("lets a success that restates the world say so", () => {
    // A refresh reloaded a table; nothing was achieved. Hardcoding "success"
    // would make every such response read as a congratulation, and the
    // protocol's `info` level unreachable through the SDK.
    expect(ok({ level: "info", message: "Orders reloaded." }).toast).toEqual({
      level: "info",
      message: "Orders reloaded.",
    });
  });

  it("builds a success that navigates", () => {
    expect(ok({ navigate: { screenId: "orders.list" } }).navigate?.screenId).toBe("orders.list");
  });

  it("builds a validation failure that names its fields", () => {
    const response = invalid({ id: "An order id is required." });
    expect(response.outcome).toBe("validation");
    expect(response.fieldErrors).toEqual({ id: "An order id is required." });
  });

  it("refuses an empty field-error map, which is the other outcome", () => {
    // The protocol says a `validation` outcome must name at least one field;
    // a satellite reaching for this with nothing to say wants `failed`.
    expect(() => invalid({})).toThrow(InvalidEnvelopeError);
  });

  it("builds a plain refusal", () => {
    expect(failed("Only pending orders can be approved.").outcome).toBe("error");
  });

  it("makes the incoherent combinations unreachable", () => {
    // `patch` on a failed outcome is the one the protocol rejects, and there is
    // no builder that can express it — `failed` takes a message and nothing
    // else. Asserted so that stays true if someone widens its input.
    const response = failed("no");
    expect(response.patch).toBeUndefined();
    expect(response.fieldErrors).toBeUndefined();
  });
});

describe("the manifest", () => {
  it("validates what the hub would validate", () => {
    const declared = manifest({
      satelliteId: "orders",
      displayName: "Orders",
      screens: [{ id: "orders.list", title: "Orders" }],
      healthPath: "/healthz",
    });
    expect(declared.protocol).toBe(CURRENT_PROTOCOL_VERSION);
    expect(declared.audience).toEqual(["internal"]);
  });

  it("refuses a nav entry naming a screen that does not exist", () => {
    // A dead link the hub only discovers when a user clicks it. The satellite's
    // own test suite catches it instead.
    expect(() =>
      manifest({
        satelliteId: "orders",
        displayName: "Orders",
        screens: [{ id: "orders.list", title: "Orders" }],
        nav: [{ screenId: "orders.gone", label: "Gone" }],
      }),
    ).toThrow(InvalidEnvelopeError);
  });

  it("keeps the parse issues on the error rather than only in its message", () => {
    // A satellite that wants to point at the offending field should not have
    // to take the message back apart to find it.
    try {
      manifest({ satelliteId: "orders", displayName: "Orders", screens: [] , nav: [{ screenId: "gone", label: "Gone" }] });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEnvelopeError);
      expect((error as InvalidEnvelopeError).issues[0]?.path).toBe("nav.0.screenId");
    }
  });

  it("refuses a screen exposed to an audience its satellite is not", () => {
    expect(() =>
      manifest({
        satelliteId: "orders",
        displayName: "Orders",
        screens: [{ id: "orders.list", title: "Orders", audience: ["internal", "external"] }],
      }),
    ).toThrow(InvalidEnvelopeError);
  });
});
