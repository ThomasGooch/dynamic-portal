import type { ExtractedData } from "@portal/mcp-gateway";
import { describe, expect, it } from "vitest";
import {
  checkOperationParams,
  checkResourceParams,
  projectOperation,
  projectResource,
} from "./respond";

const empty: ExtractedData = { tables: [], stats: [], facts: [], charts: [], text: [] };

describe("projecting a resource", () => {
  it("returns records under a public shape, not the gateway's", () => {
    const response = projectResource("order-management", "orders", "Orders", {
      ...empty,
      tables: [
        {
          id: "orders-table",
          columns: [{ key: "id", label: "Order" }],
          rows: [{ id: "ord-1" }],
          rowCount: 1,
          truncated: false,
        },
      ],
    });

    expect(response.title).toBe("Orders");
    expect(response.collections).toEqual([
      {
        name: "orders-table",
        columns: [{ key: "id", label: "Order" }],
        records: [{ id: "ord-1" }],
        recordCount: 1,
        truncated: false,
      },
    ]);
  });

  it("keeps every collection rather than guessing a primary one", () => {
    // Picking one would be right until a satellite adds a second table, at
    // which point every client silently starts reading a different one.
    const response = projectResource("s", "r", "T", {
      ...empty,
      tables: [
        { columns: [{ key: "a", label: "A" }], rows: [], rowCount: 0, truncated: false },
        { columns: [{ key: "b", label: "B" }], rows: [], rowCount: 0, truncated: false },
      ],
    });
    expect(response.collections).toHaveLength(2);
  });

  it("reports truncation, so a client knows to narrow its question", () => {
    const response = projectResource("s", "r", "T", {
      ...empty,
      tables: [
        { columns: [{ key: "a", label: "A" }], rows: [{ a: 1 }], rowCount: 5000, truncated: true },
      ],
    });
    expect(response.collections[0]).toMatchObject({ recordCount: 5000, truncated: true });
  });

  it("merges tiles and key-value pairs into one summary", () => {
    // The difference between them is a layout decision, and a client reading
    // JSON has no layout.
    const response = projectResource("s", "r", "T", {
      ...empty,
      stats: [{ label: "Pending", value: "2" }],
      facts: [{ label: "Customer", value: "Acme" }],
    });
    expect(response.summary).toEqual([
      { label: "Pending", value: "2" },
      { label: "Customer", value: "Acme" },
    ]);
  });

  it("carries no chart data, which is a drawing instruction", () => {
    const response = projectResource("s", "r", "T", {
      ...empty,
      charts: [
        { kind: "line", xKey: "day", series: [], data: [{ day: "Mon" }], truncated: false },
      ],
    });
    expect(JSON.stringify(response)).not.toContain("line");
  });
});

describe("projecting an operation", () => {
  it("returns the outcome and the satellite's own message", () => {
    expect(
      projectOperation("order-management", "approve", {
        protocol: "1.1",
        outcome: "ok",
        toast: { level: "success", message: "Order approved." },
      }),
    ).toEqual({
      service: "order-management",
      operation: "approve",
      outcome: "ok",
      message: "Order approved.",
    });
  });

  it("passes field errors through, since a client can act on them", () => {
    const response = projectOperation("s", "o", {
      protocol: "1.1",
      outcome: "validation",
      fieldErrors: { id: "required" },
    });
    expect(response.fieldErrors).toEqual({ id: "required" });
  });

  it("carries nothing a renderer would need and a client cannot use", () => {
    // `patch` and `navigate` are instructions to a renderer this client does
    // not have, and leaking them would publish the internal envelope.
    const response = projectOperation("s", "o", {
      protocol: "1.1",
      outcome: "ok",
      navigate: { screenId: "orders.list" },
    });
    expect(JSON.stringify(response)).not.toContain("orders.list");
    expect(JSON.stringify(response)).not.toContain("protocol");
  });
});

describe("checking what a client sent", () => {
  it("accepts declared parameters", () => {
    const result = checkResourceParams([{ name: "id", required: true }], { id: "ord-1" });
    expect(result).toEqual({ ok: true, value: { id: "ord-1" } });
  });

  it("refuses a parameter the resource never declared", () => {
    // The same rule the gateway applies to a tool call, run by the same
    // function — `tenantId` is the one that matters, and it must come from the
    // authenticated principal rather than a query string.
    const result = checkResourceParams([{ name: "id", required: true }], {
      id: "ord-1",
      tenantId: "someone-else",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a missing required parameter", () => {
    expect(checkResourceParams([{ name: "id", required: true }], {}).ok).toBe(false);
  });

  it("keeps an operation's declared types", () => {
    const result = checkOperationParams(
      [
        { name: "id", type: "string", required: true },
        { name: "quantity", type: "number", required: false },
      ],
      { id: "ord-1", quantity: 2 },
    );
    expect(result).toEqual({ ok: true, value: { id: "ord-1", quantity: 2 } });
  });

  it("refuses an operation argument of the wrong type", () => {
    expect(
      checkOperationParams([{ name: "quantity", type: "number", required: false }], {
        quantity: "two",
      }).ok,
    ).toBe(false);
  });

  it("refuses a value outside a declared enum", () => {
    expect(
      checkOperationParams(
        [{ name: "reason", type: "string", required: false, enum: ["late", "fraud"] }],
        { reason: "whatever" },
      ).ok,
    ).toBe(false);
  });

  it("carries a list through, and holds each entry to the declared choices", () => {
    // The façade builds the same schema the gateway does, from its own copy of
    // the conversion. Untested, the two are free to disagree about what
    // `string[]` means — and a partner would be the one to find out.
    const params = [
      { name: "tags", type: "string[]" as const, required: false, enum: ["retail", "hazmat"] },
    ];
    expect(checkOperationParams(params, { tags: ["retail"] })).toEqual({
      ok: true,
      value: { tags: ["retail"] },
    });
    // The choices constrain each entry, not the list.
    expect(checkOperationParams(params, { tags: ["retail", "explosives"] }).ok).toBe(false);
    // An object is not a list, however much `typeof` agrees.
    expect(checkOperationParams(params, { tags: {} }).ok).toBe(false);
    expect(checkOperationParams(params, { tags: "retail" }).ok).toBe(false);
  });

  it("calls a list a parameter of an operation, not of a tool", () => {
    // The message is published contract. A partner has never heard of a tool,
    // and the list branch is a new place that vocabulary could leak.
    const result = checkOperationParams(
      [{ name: "tags", type: "string[]", required: true }],
      { nope: [] },
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/operation/);
    expect(result.ok === false && result.message).not.toMatch(/tool/);
  });
});
