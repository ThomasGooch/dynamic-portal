import { describe, expect, it } from "vitest";
import { lowerSpec } from "./lower";

const spec = (elements: unknown[], root = "a") => ({ root, elements });

describe("lowerSpec", () => {
  it("turns a pair list back into the record the catalog expects", () => {
    const result = lowerSpec(
      spec([
        {
          id: "a",
          type: "Link",
          props: { label: "Detail", screenId: "orders.detail", params: [{ key: "id", value: "7" }] },
        },
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.elements[0]?.props).toEqual({
      label: "Detail",
      screenId: "orders.detail",
      params: { id: "7" },
    });
  });

  it("lowers a nested pair list too", () => {
    const result = lowerSpec(
      spec([
        {
          id: "a",
          type: "Table",
          props: {
            columns: [{ key: "id", label: "Id" }],
            source: { toolCallId: "call-1" },
            dataSource: { screenId: "orders.list", params: [{ key: "page", value: "2" }] },
          },
        },
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const props = result.spec.elements[0]?.props as Record<string, Record<string, unknown>>;
    expect(props["dataSource"]?.["params"]).toEqual({ page: "2" });
  });

  it("leaves a spec with no pair lists exactly as it found it", () => {
    const input = spec([{ id: "a", type: "Heading", props: { text: "Orders" } }]);
    const result = lowerSpec(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.elements[0]?.props).toEqual({ text: "Orders" });
  });

  it("produces a params object with no prototype", () => {
    // The keys come from a model. A borrowed prototype is one more way a
    // generated key can mean something it should not.
    const result = lowerSpec(
      spec([
        { id: "a", type: "Link", props: { label: "x", screenId: "s", params: [{ key: "k", value: "v" }] } },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const props = result.spec.elements[0]?.props as Record<string, unknown>;
    expect(Object.getPrototypeOf(props["params"])).toBeNull();
  });

  it("refuses a key that reaches for the prototype chain", () => {
    const result = lowerSpec(
      spec([
        {
          id: "a",
          type: "Link",
          props: { label: "x", screenId: "s", params: [{ key: "__proto__", value: "polluted" }] },
        },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("refuses a repeated key rather than picking a winner", () => {
    // Two declarations of one param and no way to tell which the model meant.
    // Silently keeping either produces a link to a record nobody asked for.
    const result = lowerSpec(
      spec([
        {
          id: "a",
          type: "Link",
          props: {
            label: "x",
            screenId: "s",
            params: [
              { key: "id", value: "7" },
              { key: "id", value: "8" },
            ],
          },
        },
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(/id/);
  });

  it("validates the lowered spec against the catalog", () => {
    // Lowering is not the last word: the flat schema still has to accept what
    // comes out, because the strict schema constrains the model and this
    // constrains the result.
    const result = lowerSpec(spec([{ id: "a", type: "Heading", props: { text: 42 } }]));
    expect(result.ok).toBe(false);
  });

  it("rejects a component the catalog does not have", () => {
    const result = lowerSpec(spec([{ id: "a", type: "Script", props: {} }]));
    expect(result.ok).toBe(false);
  });

  it("rejects a spec whose root names no element", () => {
    const result = lowerSpec(spec([{ id: "a", type: "Heading", props: { text: "x" } }], "nope"));
    expect(result.ok).toBe(false);
  });

  it("reports which element was wrong, not merely that something was", () => {
    const result = lowerSpec(
      spec([
        { id: "a", type: "Heading", props: { text: "fine" } },
        { id: "b", type: "Heading", props: { text: 42 } },
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.message.includes("Heading"))).toBe(true);
  });

  it("does not treat a params-shaped list on an unrelated prop as a map", () => {
    // `Tabs.tabs` is a list of objects with an `id` and a `label`, not pairs.
    // Only the properties the schema projected are converted back.
    const result = lowerSpec(
      spec([
        {
          id: "a",
          type: "Tabs",
          props: { tabs: [{ id: "one", label: "One" }] },
          children: [],
        },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const props = result.spec.elements[0]?.props as Record<string, unknown>;
    expect(props["tabs"]).toEqual([{ id: "one", label: "One" }]);
  });
});
