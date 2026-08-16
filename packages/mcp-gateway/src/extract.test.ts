import type { UiNode } from "@portal/protocol";
import { describe, expect, it } from "vitest";
import { MAX_EXTRACTED_ROWS, extractData } from "./extract";

const screen = (children: UiNode[]): UiNode => ({ type: "Page", children });

describe("extractData", () => {
  it("returns a table's rows as data, not as layout", () => {
    // The whole point. An agent asked "which orders are pending" needs the
    // rows; sending it the tree spends most of the context on `Stack` and
    // `Section` nodes it cannot use.
    const data = extractData(
      screen([
        {
          type: "Table",
          id: "orders-table",
          props: {
            columns: [
              { key: "id", label: "Order" },
              { key: "status", label: "Status" },
            ],
            rows: [{ id: "ord-1", status: "pending", statusTone: "warning" }],
          },
        },
      ]),
    );

    expect(data.tables).toEqual([
      {
        id: "orders-table",
        columns: [
          { key: "id", label: "Order" },
          { key: "status", label: "Status" },
        ],
        rows: [{ id: "ord-1", status: "pending" }],
        rowCount: 1,
        truncated: false,
      },
    ]);
  });

  it("keeps only the keys the table actually declared as columns", () => {
    // `statusTone` above is presentation the satellite sent for the renderer.
    // Passing it to a model invites a question about what "warning" means, and
    // it is a field the satellite never chose to show a human either.
    const data = extractData(
      screen([
        {
          type: "Table",
          props: {
            columns: [{ key: "id", label: "Order" }],
            rows: [{ id: "a", secret: "internal-only" }],
          },
        },
      ]),
    );
    expect(JSON.stringify(data)).not.toContain("internal-only");
  });

  it("caps rows and says that it did", () => {
    // Silently truncating is the worst option: the model answers "3 orders" on
    // a page of 3,000 and sounds certain. Saying so lets it ask for a filter.
    const rows = Array.from({ length: MAX_EXTRACTED_ROWS + 50 }, (_, i) => ({ id: String(i) }));
    const data = extractData(
      screen([{ type: "Table", props: { columns: [{ key: "id", label: "Id" }], rows } }]),
    );
    expect(data.tables[0]?.rows).toHaveLength(MAX_EXTRACTED_ROWS);
    expect(data.tables[0]?.rowCount).toBe(MAX_EXTRACTED_ROWS + 50);
    expect(data.tables[0]?.truncated).toBe(true);
  });

  it("collects stat tiles as labelled values", () => {
    const data = extractData(
      screen([
        { type: "StatTile", props: { label: "Pending", value: "2", caption: "since Monday" } },
      ]),
    );
    expect(data.stats).toEqual([{ label: "Pending", value: "2", caption: "since Monday" }]);
  });

  it("collects key-value items as facts", () => {
    const data = extractData(
      screen([
        {
          type: "KeyValueList",
          props: {
            items: [
              { label: "Customer", value: "Wile E. Coyote" },
              { label: "Total", value: "$429.99" },
            ],
          },
        },
      ]),
    );
    expect(data.facts).toEqual([
      { label: "Customer", value: "Wile E. Coyote" },
      { label: "Total", value: "$429.99" },
    ]);
  });

  it("collects chart series with their data", () => {
    const data = extractData(
      screen([
        {
          type: "Chart",
          props: {
            kind: "line",
            xKey: "day",
            series: [{ key: "count", label: "Orders" }],
            data: [{ day: "Mon", count: 4 }],
          },
        },
      ]),
    );
    expect(data.charts).toEqual([
      {
        kind: "line",
        xKey: "day",
        series: [{ key: "count", label: "Orders" }],
        data: [{ day: "Mon", count: 4 }],
        truncated: false,
      },
    ]);
  });

  it("collects prose so a warning on the screen is not invisible to the agent", () => {
    // An `Alert` saying "two orders are late" is the answer to a question, and
    // dropping it because it is not a table would make the agent contradict
    // what the user is looking at.
    const data = extractData(
      screen([
        { type: "Heading", props: { text: "Orders" } },
        { type: "Text", props: { text: "Nothing pending." } },
        { type: "Alert", props: { level: "warning", title: "Late", message: "Two are late." } },
        { type: "EmptyState", props: { title: "No orders", message: "Nothing here yet." } },
        { type: "Badge", props: { label: "Live" } },
      ]),
    );
    expect(data.text).toEqual([
      "Orders",
      "Nothing pending.",
      "Late: Two are late.",
      "No orders: Nothing here yet.",
      "Live",
    ]);
  });

  it("reads a deeply nested tree without recursing", () => {
    // Trees arrive bounded at MAX_NODE_DEPTH, but this walks caller-supplied
    // data and the bound is enforced somewhere else. Iterative here means the
    // two are not coupled by an assumption nobody restates.
    let node: UiNode = { type: "StatTile", props: { label: "Deep", value: "1" } };
    for (let i = 0; i < 5000; i += 1) node = { type: "Section", children: [node] };
    expect(extractData(node).stats).toEqual([{ label: "Deep", value: "1" }]);
  });

  it("keeps document order across node kinds", () => {
    const data = extractData(
      screen([
        { type: "StatTile", props: { label: "A", value: "1" } },
        { type: "StatTile", props: { label: "B", value: "2" } },
      ]),
    );
    expect(data.stats.map((s) => s.label)).toEqual(["A", "B"]);
  });

  it("ignores a node whose props are not what its type implies", () => {
    // Screens reaching here are catalog-validated, but this function is also
    // the agent's view of a *patch* subtree and of anything a future producer
    // sends. It reports what it understood rather than throwing.
    const data = extractData(
      screen([
        { type: "Table", props: { columns: "not an array", rows: 3 } },
        { type: "StatTile", props: { label: "Fine", value: "1" } },
      ]),
    );
    expect(data.tables).toEqual([]);
    expect(data.stats).toHaveLength(1);
  });

  it("returns empty collections rather than absent ones", () => {
    const data = extractData(screen([]));
    expect(data).toEqual({ tables: [], stats: [], facts: [], charts: [], text: [] });
  });
});
