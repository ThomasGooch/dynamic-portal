import type { ExtractedData } from "@portal/mcp-gateway";
import { describe, expect, it } from "vitest";
import { groundSpec, type ToolCallRecord } from "./grounding";
import { lowerSpec } from "./lower";

const empty: ExtractedData = { tables: [], stats: [], facts: [], charts: [], text: [] };

const call = (toolCallId: string, data: Partial<ExtractedData>): ToolCallRecord => ({
  toolCallId,
  data: { ...empty, ...data },
});

const ordersTable = {
  columns: [
    { key: "id", label: "Order" },
    { key: "status", label: "Status" },
  ],
  rows: [
    { id: "ord-1", status: "pending" },
    { id: "ord-2", status: "approved" },
  ],
  rowCount: 2,
  truncated: false,
};

/** Builds a spec the way the model would, then lowers it, then grounds it. */
function ground(elements: unknown[], calls: readonly ToolCallRecord[], root = "a") {
  const lowered = lowerSpec({ root, elements });
  if (!lowered.ok) throw new Error(`fixture does not lower: ${lowered.issues[0]?.message}`);
  return groundSpec(lowered.spec, calls);
}

describe("tables", () => {
  it("fills rows from the tool call the node cites", () => {
    // The model never wrote a row — the schema gave it nowhere to. This is
    // where the data arrives, from the call the node named.
    const result = ground(
      [
        {
          id: "a",
          type: "Table",
          props: {
            columns: [
              { key: "id", label: "Order" },
              { key: "status", label: "Status" },
            ],
            source: { toolCallId: "call-1" },
          },
        },
      ],
      [call("call-1", { tables: [ordersTable] })],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.elements[0]?.props?.["rows"]).toEqual([
      { id: "ord-1", status: "pending" },
      { id: "ord-2", status: "approved" },
    ]);
  });

  it("refuses a citation naming a call that never happened", () => {
    // The whole point. A model that invents a tool call id would otherwise get
    // a table rendered with whatever happened to be lying around.
    const result = ground(
      [
        {
          id: "a",
          type: "Table",
          props: { columns: [{ key: "id", label: "Order" }], source: { toolCallId: "invented" } },
        },
      ],
      [call("call-1", { tables: [ordersTable] })],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(/invented/);
  });

  it("refuses a table whose columns the cited call cannot supply", () => {
    // Citing a real call is not the same as citing the *right* one. A column
    // the result has no key for would render as a page of dashes.
    const result = ground(
      [
        {
          id: "a",
          type: "Table",
          props: {
            columns: [{ key: "customerEmail", label: "Email" }],
            source: { toolCallId: "call-1" },
          },
        },
      ],
      [call("call-1", { tables: [ordersTable] })],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(/customerEmail/);
  });

  it("refuses when the cited call offers two tables that both fit", () => {
    // Picking one is a guess, and the wrong guess is a screen of plausible
    // numbers from the wrong query.
    const result = ground(
      [
        {
          id: "a",
          type: "Table",
          props: { columns: [{ key: "id", label: "Id" }], source: { toolCallId: "call-1" } },
        },
      ],
      [call("call-1", { tables: [ordersTable, { ...ordersTable, id: "other" }] })],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(/more than one/i);
  });

  it("resolves the ambiguity when the node names the table it means", () => {
    const result = ground(
      [
        {
          id: "orders-table",
          type: "Table",
          props: { columns: [{ key: "id", label: "Id" }], source: { toolCallId: "call-1" } },
        },
      ],
      [
        call("call-1", {
          tables: [
            { ...ordersTable, id: "orders-table" },
            { ...ordersTable, id: "other" },
          ],
        }),
      ],
      "orders-table",
    );
    expect(result.ok).toBe(true);
  });

  it("keeps only the columns the model asked for", () => {
    // The extracted table may be wider than the screen the model composed.
    const result = ground(
      [
        {
          id: "a",
          type: "Table",
          props: { columns: [{ key: "status", label: "Status" }], source: { toolCallId: "call-1" } },
        },
      ],
      [call("call-1", { tables: [ordersTable] })],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.elements[0]?.props?.["rows"]).toEqual([
      { status: "pending" },
      { status: "approved" },
    ]);
  });
});

describe("stat tiles", () => {
  it("accepts a value the cited call actually reported", () => {
    const result = ground(
      [
        {
          id: "a",
          type: "StatTile",
          props: { label: "Pending", value: "2", source: { toolCallId: "call-1" } },
        },
      ],
      [call("call-1", { stats: [{ label: "Pending", value: "2" }] })],
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a number that appears nowhere in the call it cites", () => {
    // A citation proves the model looked something up. It does not prove the
    // number came from there, and this is the difference.
    const result = ground(
      [
        {
          id: "a",
          type: "StatTile",
          props: { label: "Pending", value: "47", source: { toolCallId: "call-1" } },
        },
      ],
      [call("call-1", { stats: [{ label: "Pending", value: "2" }] })],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(/47/);
  });

  it("accepts a value taken from a table cell rather than a stat", () => {
    const result = ground(
      [
        {
          id: "a",
          type: "StatTile",
          props: { label: "First order", value: "ord-1", source: { toolCallId: "call-1" } },
        },
      ],
      [call("call-1", { tables: [ordersTable] })],
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a value taken from a key-value fact", () => {
    const result = ground(
      [
        {
          id: "a",
          type: "StatTile",
          props: { label: "Customer", value: "Wile E. Coyote", source: { toolCallId: "call-1" } },
        },
      ],
      [call("call-1", { facts: [{ label: "Customer", value: "Wile E. Coyote" }] })],
    );
    expect(result.ok).toBe(true);
  });

  it("counts a number in the result as matching the string the model wrote", () => {
    // Extracted cells keep their JSON types; a StatTile value is a string.
    const result = ground(
      [
        {
          id: "a",
          type: "StatTile",
          props: { label: "Total", value: "429.99", source: { toolCallId: "call-1" } },
        },
      ],
      [
        call("call-1", {
          tables: [
            {
              columns: [{ key: "total", label: "Total" }],
              rows: [{ total: 429.99 }],
              rowCount: 1,
              truncated: false,
            },
          ],
        }),
      ],
    );
    expect(result.ok).toBe(true);
  });
});

describe("charts", () => {
  it("fills series data from a cited chart", () => {
    const result = ground(
      [
        {
          id: "a",
          type: "Chart",
          props: {
            kind: "line",
            xKey: "day",
            series: [{ key: "count", label: "Orders" }],
            source: { toolCallId: "call-1" },
          },
        },
      ],
      [
        call("call-1", {
          charts: [
            {
              kind: "line",
              xKey: "day",
              series: [{ key: "count", label: "Orders" }],
              data: [{ day: "Mon", count: 4 }],
              truncated: false,
            },
          ],
        }),
      ],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.elements[0]?.props?.["data"]).toEqual([{ day: "Mon", count: 4 }]);
  });

  it("builds a chart out of a table when the keys are all there", () => {
    // The interesting case: the model turns a list into a chart. It still
    // cannot invent the points.
    const result = ground(
      [
        {
          id: "a",
          type: "Chart",
          props: {
            kind: "bar",
            xKey: "id",
            series: [{ key: "status", label: "Status" }],
            source: { toolCallId: "call-1" },
          },
        },
      ],
      [call("call-1", { tables: [ordersTable] })],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.elements[0]?.props?.["data"]).toEqual([
      { id: "ord-1", status: "pending" },
      { id: "ord-2", status: "approved" },
    ]);
  });

  it("refuses a chart whose keys nothing in the cited call supplies", () => {
    const result = ground(
      [
        {
          id: "a",
          type: "Chart",
          props: {
            kind: "line",
            xKey: "week",
            series: [{ key: "revenue", label: "Revenue" }],
            source: { toolCallId: "call-1" },
          },
        },
      ],
      [call("call-1", { tables: [ordersTable] })],
    );
    expect(result.ok).toBe(false);
  });
});

describe("what needs no grounding", () => {
  it("leaves layout and prose alone", () => {
    const result = ground(
      [
        { id: "a", type: "Page", props: {}, children: ["b", "c"] },
        { id: "b", type: "Heading", props: { text: "Blocked orders" } },
        { id: "c", type: "Text", props: { text: "Two of these are waiting on a vehicle." } },
      ],
      [],
    );
    expect(result.ok).toBe(true);
  });

  it("reports every ungrounded node, not only the first", () => {
    // A model that has lost the thread produces several at once, and fixing
    // them one round trip at a time is the expensive way to find that out.
    const result = ground(
      [
        { id: "a", type: "Page", props: {}, children: ["b", "c"] },
        {
          id: "b",
          type: "StatTile",
          props: { label: "One", value: "9", source: { toolCallId: "nope" } },
        },
        {
          id: "c",
          type: "StatTile",
          props: { label: "Two", value: "8", source: { toolCallId: "nope" } },
        },
      ],
      [],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.elementId).sort()).toEqual(["b", "c"]);
  });

  it("still returns a spec the catalog accepts once rows are filled in", () => {
    // Substitution puts `rows` back on a node the model was not allowed to
    // write them on, so the result is re-validated rather than trusted.
    const result = ground(
      [
        {
          id: "a",
          type: "Table",
          props: { columns: [{ key: "id", label: "Order" }], source: { toolCallId: "call-1" } },
        },
      ],
      [call("call-1", { tables: [ordersTable] })],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(lowerSpec(result.spec).ok).toBe(true);
  });
});
