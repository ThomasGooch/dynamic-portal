// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UiNode } from "@portal/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Node } from "../Node";
import { RenderProvider } from "../context";
import type { ActionRequest } from "../context";

/**
 * A form answering its own questions, driven the way a person drives it.
 *
 * `renderer.test.tsx` asserts what the hub *emits* and is deliberately static.
 * Conditional visibility is not a static property: the claim is that a hidden
 * field leaves the DOM and therefore leaves the payload, and that a rule
 * reading a field that has itself gone stops holding. Both need something to
 * click, and the e2e suite does not run in CI.
 */

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLElement;
let root: Root;
let dispatched: ActionRequest[];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  dispatched = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: UiNode): void {
  act(() => {
    root.render(
      (
        <RenderProvider
          value={{
            satelliteId: "orders",
            screenId: "orders.new",
            params: {},
            allowedSatelliteIds: ["orders"],
            fieldErrors: {},
            busy: false,
            dispatch: (request) => {
              dispatched.push(request);
            },
          }}
        >
          <Node node={node} />
        </RenderProvider>
      ) as ReactNode,
    );
  });
}

const field = (name: string): HTMLInputElement | null =>
  container.querySelector(`[name="${name}"]`);

/** Typing, as the browser does it: React tracks the value, so set it its way. */
function type(name: string, value: string): void {
  const input = field(name)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(name: string): void {
  act(() => {
    field(name)!.click();
  });
}

function submit(): void {
  act(() => {
    container.querySelector("form")!.requestSubmit();
  });
}

const form = (...children: UiNode[]): UiNode => ({
  type: "Form",
  props: { actionId: "orders.create", submitLabel: "Create" },
  children,
});

const conditional: UiNode[] = [
  { type: "Checkbox", props: { name: "expedited", label: "Expedite this order" } },
  {
    type: "TextField",
    props: {
      name: "expediteReason",
      label: "Why is this expedited?",
      visibleWhen: { field: "expedited", equals: true },
    },
  },
  {
    type: "TextField",
    props: {
      name: "approver",
      label: "Who approved it?",
      visibleWhen: { field: "expediteReason", equals: "finance" },
    },
  },
];

describe("a form whose fields declare when they are shown", () => {
  it("draws neither the field nor the one that depends on it", () => {
    render(form(...conditional));

    expect(field("expediteReason")).toBeNull();
    expect(field("approver")).toBeNull();
  });

  it("draws a field the moment its condition holds", () => {
    render(form(...conditional));

    click("expedited");
    expect(field("expediteReason")).not.toBeNull();

    type("expediteReason", "finance");
    expect(field("approver")).not.toBeNull();
  });

  it("takes a chain of fields away with the field they depend on", () => {
    // The one that bites: `approver` reads `expediteReason`, which has just
    // left the DOM. If "no such value" meant "show it", `approver` would appear
    // exactly when its condition cannot hold — and be submitted.
    render(form(...conditional));

    click("expedited");
    type("expediteReason", "finance");
    expect(field("approver")).not.toBeNull();

    click("expedited");
    expect(field("expediteReason")).toBeNull();
    expect(field("approver")).toBeNull();
  });

  it("submits nothing for a field that is hidden, whatever was typed in it", () => {
    render(form(...conditional));

    click("expedited");
    type("expediteReason", "finance");
    click("expedited");
    submit();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.payload).toEqual({ expedited: false });
  });

  it("submits a hidden field's value never, not even the one it was given", () => {
    // A `value` from the satellite is a `defaultValue` in the DOM, so a hidden
    // field with one is the case where "hidden means absent" is easiest to get
    // wrong: there is something to send even though nobody typed it.
    render(
      form(
        { type: "Checkbox", props: { name: "expedited", label: "Expedite" } },
        {
          type: "TextField",
          props: {
            name: "expediteReason",
            label: "Why?",
            value: "signed off by finance",
            visibleWhen: { field: "expedited", equals: true },
          },
        },
      ),
    );

    submit();
    expect(dispatched[0]?.payload).toEqual({ expedited: false });
  });

  it("draws a field whose condition the satellite already prefilled", () => {
    // Editing an order that is already expedited. There is nothing to click,
    // so this is the case the first render has to get right on its own.
    render(
      form(
        { type: "Checkbox", props: { name: "expedited", label: "Expedite", checked: true } },
        {
          type: "TextField",
          props: {
            name: "expediteReason",
            label: "Why?",
            value: "signed off by finance",
            visibleWhen: { field: "expedited", equals: true },
          },
        },
      ),
    );

    expect(field("expediteReason")).not.toBeNull();
    submit();
    expect(dispatched[0]?.payload).toEqual({
      expedited: true,
      expediteReason: "signed off by finance",
    });
  });

  it("keeps a field whose condition names a disabled control it can still read", () => {
    // A disabled control is on the screen with a value in it; it is only
    // excluded from the *payload*. Reading the payload for visibility would
    // make disabling one field silently remove another.
    render(
      form(
        { type: "Checkbox", props: { name: "expedited", label: "Expedite", checked: true, disabled: true } },
        {
          type: "TextField",
          props: {
            name: "expediteReason",
            label: "Why?",
            visibleWhen: { field: "expedited", equals: true },
          },
        },
      ),
    );

    expect(field("expediteReason")).not.toBeNull();
  });

  it("hides a checkbox that declares a condition, which draws its own shell", () => {
    render(
      form(
        { type: "Select", props: { name: "kind", label: "Kind", options: [{ value: "hazmat", label: "Hazmat" }] } },
        {
          type: "Checkbox",
          props: {
            name: "agree",
            label: "I accept the handling terms",
            visibleWhen: { field: "kind", equals: "hazmat" },
          },
        },
      ),
    );

    expect(field("agree")).toBeNull();
    submit();
    expect(dispatched[0]?.payload).toEqual({ kind: "" });
  });

  it("leaves no empty fieldset where a hidden radio group was", () => {
    render(
      form(
        { type: "Checkbox", props: { name: "expedited", label: "Expedite" } },
        {
          type: "RadioGroup",
          props: {
            name: "priority",
            label: "Priority",
            options: [{ value: "express", label: "Express" }],
            visibleWhen: { field: "expedited", equals: true },
          },
        },
      ),
    );

    expect(container.querySelector("fieldset")).toBeNull();
    click("expedited");
    expect(container.querySelector("fieldset")).not.toBeNull();
  });
});
