// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { UiNode } from "@portal/protocol";
import { collectFormValues, initialFormValues } from "./formValues";

function form(html: string): HTMLFormElement {
  document.body.innerHTML = `<form>${html}</form>`;
  return document.body.querySelector("form") as HTMLFormElement;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("collectFormValues", () => {
  it("collects text inputs as strings", () => {
    const values = collectFormValues(form(`<input name="email" value="a@b.example">`));
    expect(values).toEqual({ email: "a@b.example" });
  });

  it("collects a number field as a number, not the string the DOM holds", () => {
    // Every DOM value is a string. A satellite that declared a NumberField and
    // receives "12" has to parse it back, and the one that forgets compares a
    // string to a number and silently takes the wrong branch.
    const values = collectFormValues(form(`<input type="number" name="qty" value="12">`));
    expect(values).toEqual({ qty: 12 });
  });

  it("sends an empty number field as null rather than NaN or an empty string", () => {
    const values = collectFormValues(form(`<input type="number" name="qty" value="">`));
    expect(values).toEqual({ qty: null });
  });

  it("collects a checkbox as a boolean in both states", () => {
    // The browser omits an unchecked box from a form submission entirely, so a
    // satellite reading FormData cannot tell "unchecked" from "not on the form".
    expect(collectFormValues(form(`<input type="checkbox" name="ok" checked>`))).toEqual({
      ok: true,
    });
    expect(collectFormValues(form(`<input type="checkbox" name="ok">`))).toEqual({ ok: false });
  });

  it("collects a radio group as the selected value only", () => {
    const values = collectFormValues(
      form(`
        <input type="radio" name="tier" value="basic">
        <input type="radio" name="tier" value="pro" checked>
      `),
    );
    expect(values).toEqual({ tier: "pro" });
  });

  it("collects an unanswered radio group as null", () => {
    const values = collectFormValues(
      form(`<input type="radio" name="tier" value="basic">
            <input type="radio" name="tier" value="pro">`),
    );
    expect(values).toEqual({ tier: null });
  });

  it("collects a multi-select as an array, even with one or no selection", () => {
    const html = (selected: string[]) =>
      `<select name="tags" multiple>${["a", "b"]
        .map((v) => `<option value="${v}"${selected.includes(v) ? " selected" : ""}>${v}</option>`)
        .join("")}</select>`;

    expect(collectFormValues(form(html(["a", "b"])))).toEqual({ tags: ["a", "b"] });
    expect(collectFormValues(form(html(["b"])))).toEqual({ tags: ["b"] });
    expect(collectFormValues(form(html([])))).toEqual({ tags: [] });
  });

  it("collects a single select as a string", () => {
    const values = collectFormValues(
      form(`<select name="tier"><option value="a">a</option><option value="b" selected>b</option></select>`),
    );
    expect(values).toEqual({ tier: "b" });
  });

  it("nests a dotted name, so a DateRange arrives shaped like its own props", () => {
    const values = collectFormValues(
      form(`<input name="window.from" value="2026-01-01"><input name="window.to" value="2026-02-01">`),
    );
    expect(values).toEqual({ window: { from: "2026-01-01", to: "2026-02-01" } });
  });

  it("refuses to walk a dotted name into the prototype chain", () => {
    // Field names come from the satellite. Writing through `__proto__` here
    // would change every object in the hub's process, not just this payload.
    const values = collectFormValues(
      form(`<input name="__proto__.polluted" value="yes">
            <input name="constructor.prototype.x" value="yes">`),
    );
    expect(values).toEqual({});
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("skips a file input, which the action envelope cannot carry", () => {
    // Sending the filename alone would look like an upload that worked.
    const values = collectFormValues(
      form(`<input type="file" name="doc"><input name="title" value="t">`),
    );
    expect(values).toEqual({ title: "t" });
  });

  it("ignores controls with no name, including the submit button", () => {
    const values = collectFormValues(
      form(`<input value="anonymous"><button type="submit">Go</button><input name="x" value="1">`),
    );
    expect(values).toEqual({ x: "1" });
  });

  it("ignores a disabled control, matching what the browser would submit", () => {
    const values = collectFormValues(form(`<input name="x" value="1" disabled>`));
    expect(values).toEqual({});
  });

  it("collects a textarea", () => {
    const values = collectFormValues(form(`<textarea name="note">hello</textarea>`));
    expect(values).toEqual({ note: "hello" });
  });

  it("collects a hidden input", () => {
    const values = collectFormValues(form(`<input type="hidden" name="id" value="42">`));
    expect(values).toEqual({ id: "42" });
  });

  it("returns a null-prototype object", () => {
    // The payload is JSON.stringify'd and posted. A borrowed prototype is one
    // more way for a field name to mean something it should not.
    const values = collectFormValues(form(`<input name="x" value="1">`));
    expect(Object.getPrototypeOf(values)).toBeNull();
  });
});

describe("initialFormValues", () => {
  const node = (type: string, props: Record<string, unknown>): UiNode => ({ type, props });

  const formNode = (...children: UiNode[]): UiNode => ({ type: "Form", props: {}, children });

  it("answers what the form would collect before anything is touched", () => {
    // The point of the pairing: the shapes have to match `collectFormValues`,
    // because a condition is evaluated against one of them before hydration and
    // the other after, and a field that changed shape in between would appear
    // and then vanish.
    const values = initialFormValues(
      formNode(
        node("TextField", { name: "customer", label: "Customer", value: "Acme" }),
        node("TextField", { name: "empty", label: "Empty" }),
        node("NumberField", { name: "total", label: "Total", value: 12.5 }),
        node("NumberField", { name: "blank", label: "Blank" }),
        node("Checkbox", { name: "expedited", label: "Expedite", checked: true }),
        node("Switch", { name: "live", label: "Live" }),
      ),
    );

    expect(values).toEqual({
      customer: "Acme",
      empty: "",
      total: 12.5,
      blank: null,
      expedited: true,
      live: false,
    });
  });

  it("nests a DateRange the way its two inputs collect", () => {
    const values = initialFormValues(
      formNode(node("DateRange", { name: "window", label: "Window", from: "2026-01-01" })),
    );
    expect(values).toEqual({ window: { from: "2026-01-01", to: "" } });
  });

  it("keeps only the choices that name a real option", () => {
    // The renderer falls back to the placeholder for a `value` naming no
    // option, and the browser selects nothing for one in a multi-select. A
    // reading that disagreed would answer a condition the DOM never would.
    const values = initialFormValues(
      formNode(
        node("Select", {
          name: "tier",
          label: "Tier",
          options: [{ value: "a", label: "A" }],
          value: "gone",
        }),
        node("MultiSelect", {
          name: "tags",
          label: "Tags",
          options: [{ value: "hazmat", label: "Hazmat" }],
          value: ["hazmat", "gone"],
        }),
        node("RadioGroup", {
          name: "priority",
          label: "Priority",
          options: [{ value: "express", label: "Express" }],
        }),
      ),
    );

    expect(values).toEqual({ tier: "", tags: ["hazmat"], priority: null });
  });

  it("finds fields wherever the tree puts them, and skips a nested form's", () => {
    const values = initialFormValues(
      formNode(
        { type: "Section", props: { title: "Details" }, children: [
          node("TextField", { name: "deep", label: "Deep", value: "found" }),
        ] },
        { type: "Form", props: { actionId: "other" }, children: [
          node("TextField", { name: "theirs", label: "Theirs", value: "not ours" }),
        ] },
      ),
    );

    expect(values).toEqual({ deep: "found" });
  });

  it("reports nothing for a file upload, which carries no value either way", () => {
    const values = initialFormValues(formNode(node("FileUpload", { name: "doc", label: "Doc" })));
    expect(values).toEqual({});
  });

  it("returns a null-prototype object, like the reading it stands in for", () => {
    expect(Object.getPrototypeOf(initialFormValues(formNode()))).toBeNull();
  });
});
