import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COMPONENT_NAMES, type ComponentName } from "@portal/catalog";
import type { UiNode } from "@portal/protocol";
import { describe, expect, it } from "vitest";
import { Node } from "./Node";
import { RenderProvider } from "./context";
import { RENDERERS } from "./registry";

/**
 * Rendered with `react-dom/server` rather than a testing library: these assert
 * what the hub *emits*, which is the thing the trust boundary is about. What
 * happens on click is an interaction, and interactions are e2e's job.
 */
function render(node: UiNode, allowed: readonly string[] = ["orders", "fleet"]): string {
  return renderToStaticMarkup(
    <RenderProvider
      value={{
        satelliteId: "orders",
        screenId: "orders.list",
        params: {},
        allowedSatelliteIds: allowed,
        fieldErrors: {},
        busy: false,
        dispatch: () => {},
      }}
    >
      <Node node={node} />
    </RenderProvider> as ReactNode,
  );
}

/** One valid example per component, so every entry in the catalog is rendered. */
const EXAMPLES: Record<ComponentName, Record<string, unknown>> = {
  Page: { title: "Orders" },
  Section: { title: "Recent", description: "Last 30 days" },
  Stack: { direction: "row", gap: "lg" },
  Grid: { columns: 3 },
  Card: { title: "Summary", tone: "info" },
  Tabs: { tabs: [{ id: "a", label: "Open" }, { id: "b", label: "Closed" }] },
  Divider: { spacing: "lg" },
  Modal: { title: "Confirm", open: true },

  Heading: { text: "Orders", level: 2 },
  Text: { text: "Nothing pending.", tone: "muted" },
  Badge: { label: "Open", tone: "success" },
  StatTile: { label: "Open orders", value: "42", caption: "since Monday" },
  KeyValueList: { items: [{ label: "Status", value: "Shipped", as: "badge", tone: "success" }] },
  Table: {
    columns: [{ key: "id", label: "ID" }, { key: "total", label: "Total", as: "money" }],
    rows: [{ id: "A-1", total: 12.5 }],
    rowAction: { screenId: "orders.detail", paramKey: "id" },
    page: 1,
    pageSize: 1,
    total: 3,
  },
  Chart: {
    kind: "bar",
    xKey: "day",
    series: [{ key: "count", label: "Orders" }],
    data: [{ day: "Mon", count: 4 }],
  },
  Alert: { level: "warning", title: "Heads up", message: "Two orders are late." },
  EmptyState: { title: "No orders", message: "Nothing here yet.", actionLabel: "Refresh", action: { actionId: "orders.refresh" } },
  Timeline: { items: [{ timestamp: "2026-03-04T22:30:00Z", label: "Created" }] },

  Form: { actionId: "orders.create", submitLabel: "Create" },
  TextField: { name: "email", label: "Email", required: true, help: "Work address" },
  TextArea: { name: "note", label: "Note", rows: 3 },
  NumberField: { name: "qty", label: "Quantity", min: 1, max: 10, step: 1 },
  Select: { name: "tier", label: "Tier", options: [{ value: "a", label: "A" }] },
  MultiSelect: { name: "tags", label: "Tags", options: [{ value: "a", label: "A" }] },
  DateField: { name: "due", label: "Due" },
  DateRange: { name: "window", label: "Window" },
  Checkbox: { name: "ok", label: "Confirmed" },
  Switch: { name: "live", label: "Live" },
  RadioGroup: { name: "tier", label: "Tier", options: [{ value: "a", label: "A" }] },
  FileUpload: { name: "doc", label: "Document" },
  Hidden: { name: "id", value: "42" },

  Button: { label: "Approve", variant: "primary", action: { actionId: "orders.approve" } },
  Link: { label: "Detail", screenId: "orders.detail" },
  MenuButton: { label: "More", items: [{ label: "Archive", action: { actionId: "orders.archive" } }] },
};

describe("the component registry", () => {
  it("has a renderer for every component in the catalog", () => {
    // The map's type already makes a missing entry a compile error. This
    // catches the other half — an entry present but undefined, which types
    // cannot see through a `Record` built from imports.
    for (const name of COMPONENT_NAMES) {
      expect(RENDERERS[name], name).toBeTypeOf("function");
    }
  });

  it("has an example for every component, so the suite below covers all of them", () => {
    // Without this, adding a component to the catalog silently adds an
    // untested one: the loop over EXAMPLES would simply not visit it.
    expect(Object.keys(EXAMPLES).sort()).toEqual([...COMPONENT_NAMES].sort());
  });

  it.each(COMPONENT_NAMES)("renders %s without throwing", (name) => {
    const markup = render({ type: name, props: EXAMPLES[name], children: [] });
    expect(markup).not.toContain("r-unrenderable");
  });
});

describe("the styling boundary", () => {
  it.each(COMPONENT_NAMES)("emits no satellite-authored class or style on %s", (name) => {
    const markup = render({ type: name, props: EXAMPLES[name], children: [] });
    // Every class in the output must be one of the hub's own. A satellite can
    // set no class at all — the catalog rejects the prop — so anything here
    // that is not `r-`-prefixed came from somewhere unexpected.
    for (const match of markup.matchAll(/class="([^"]*)"/g)) {
      for (const cls of (match[1] ?? "").split(/\s+/).filter(Boolean)) {
        expect(cls, `${name} emitted class "${cls}"`).toMatch(/^(r-|recharts-)/);
      }
    }
  });

  it("refuses a node carrying className and says so on screen", () => {
    // Rejected by the catalog schema; the point of the assertion is that the
    // refusal is *visible* rather than a silently dropped prop.
    const markup = render({ type: "Text", props: { text: "hi", className: "evil" } });
    expect(markup).toContain("r-unrenderable");
    expect(markup).toContain("Text");
  });

  it("refuses a node carrying style", () => {
    const markup = render({ type: "Card", props: { style: "color:red" } });
    expect(markup).toContain("r-unrenderable");
  });

  it("shows a labelled placeholder for a component it does not know", () => {
    const markup = render({ type: "Script", props: {} });
    expect(markup).toContain("r-unrenderable");
    expect(markup).toContain("Script");
  });

  it("does not echo the offending props back into the DOM", () => {
    // They are exactly what was found unacceptable; rendering them would
    // undo the check.
    const markup = render({ type: "Text", props: { text: "hi", className: "evil-marker" } });
    expect(markup).not.toContain("evil-marker");
  });
});

describe("links", () => {
  it("renders an internal link as a real href", () => {
    const markup = render({ type: "Link", props: { label: "Go", screenId: "orders.detail" } });
    expect(markup).toContain('href="/orders/orders.detail"');
  });

  it("puts no href in the DOM for a javascript: url", () => {
    // The catalog rejects it first, so this is the placeholder path — either
    // way, what must never appear in the markup is the url.
    const markup = render({ type: "Link", props: { label: "Go", href: "javascript:alert(1)" } });
    expect(markup).not.toContain("javascript:");
  });

  it("renders a link to an invisible satellite as inert text, not an anchor", () => {
    const markup = render(
      { type: "Link", props: { label: "Payroll", screenId: "x", satelliteId: "payroll" } },
      ["orders"],
    );
    expect(markup).toContain("data-inert");
    expect(markup).not.toContain("<a ");
    expect(markup).toContain("Payroll");
  });

  it("opens an external link without handing it window.opener", () => {
    const markup = render({ type: "Link", props: { label: "Docs", href: "https://example.com" } });
    expect(markup).toContain('rel="noopener noreferrer"');
  });
});

describe("headings", () => {
  it("descends a level per nested container instead of repeating h2", () => {
    const markup = render({
      type: "Page",
      props: {},
      children: [
        {
          type: "Section",
          props: { title: "Outer" },
          children: [{ type: "Card", props: { title: "Inner" }, children: [] }],
        },
      ],
    });
    expect(markup).toContain("<h2 class=\"r-title\">Outer</h2>");
    expect(markup).toContain("<h3 class=\"r-title\">Inner</h3>");
  });

  it("never emits a second h1 under the screen title", () => {
    const markup = render({ type: "Heading", props: { text: "Top", level: 1 } });
    expect(markup).not.toContain("<h1");
  });
});

describe("grid", () => {
  it("clamps a column count the catalog cannot constrain", () => {
    // The catalog carries no range keywords on purpose — structured outputs
    // reject them — so `columns` is bounded here or nowhere.
    expect(render({ type: "Grid", props: { columns: 9999 } })).toContain(
      "repeat(12, minmax(0, 1fr))",
    );
    expect(render({ type: "Grid", props: { columns: 0 } })).toContain(
      "repeat(1, minmax(0, 1fr))",
    );
    expect(render({ type: "Grid", props: { columns: -4 } })).toContain(
      "repeat(1, minmax(0, 1fr))",
    );
  });
});

describe("tables", () => {
  it("links only the first cell, so the row stays copyable and middle-clickable", () => {
    const markup = render({
      type: "Table",
      props: {
        columns: [{ key: "id", label: "ID" }, { key: "name", label: "Name" }],
        rows: [{ id: "7", name: "Widget" }],
        rowAction: { screenId: "orders.detail", paramKey: "id" },
      },
    });
    expect(markup).toContain('href="/orders/orders.detail?id=7"');
    expect([...markup.matchAll(/<a /g)]).toHaveLength(1);
  });

  it("renders a row whose link key is missing without a dead link", () => {
    const markup = render({
      type: "Table",
      props: {
        columns: [{ key: "name", label: "Name" }],
        rows: [{ name: "Widget" }],
        rowAction: { screenId: "orders.detail", paramKey: "id" },
      },
    });
    expect(markup).not.toContain("<a ");
    expect(markup).toContain("Widget");
  });

  it("shows the satellite's empty message rather than an empty table", () => {
    const markup = render({
      type: "Table",
      props: { columns: [{ key: "id", label: "ID" }], rows: [], emptyMessage: "No orders yet" },
    });
    expect(markup).toContain("No orders yet");
    expect(markup).not.toContain("<table");
  });

  it("does not offer paging when the satellite did not say how many rows exist", () => {
    // A Next button that might lead nowhere is worse than no button.
    const markup = render({
      type: "Table",
      props: {
        columns: [{ key: "id", label: "ID" }],
        rows: [{ id: 1 }],
        page: 1,
        pageSize: 10,
      },
    });
    expect(markup).not.toContain("r-pager");
  });

  it("renders a cell that is an object as json rather than [object Object]", () => {
    const markup = render({
      type: "Table",
      props: { columns: [{ key: "meta", label: "Meta" }], rows: [{ meta: { a: 1 } }] },
    });
    expect(markup).toContain("{&quot;a&quot;:1}");
  });
});

describe("fields", () => {
  it("marks a field with an error for assistive technology, not just in colour", () => {
    const markup = renderToStaticMarkup(
      <RenderProvider
        value={{
          satelliteId: "orders",
          screenId: "orders.new",
          params: {},
          allowedSatelliteIds: ["orders"],
          fieldErrors: { email: "Already in use" },
          busy: false,
          dispatch: () => {},
        }}
      >
        <Node node={{ type: "TextField", props: { name: "email", label: "Email" } }} />
      </RenderProvider> as ReactNode,
    );
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('aria-describedby="field-email-error"');
    expect(markup).toContain("Already in use");
  });

  it("says a file will not be sent rather than letting the user find out", () => {
    const markup = render({ type: "FileUpload", props: { name: "doc", label: "Document" } });
    expect(markup).toMatch(/not yet carried/i);
  });

  it("gives a DateRange two controls whose names nest into one value", () => {
    const markup = render({ type: "DateRange", props: { name: "window", label: "Window" } });
    expect(markup).toContain('name="window.from"');
    expect(markup).toContain('name="window.to"');
  });
});
