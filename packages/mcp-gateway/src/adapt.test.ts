import { describe, expect, it } from "vitest";
import { adaptMcpResult } from "./adapt";
import { MAX_EXTRACTED_ROWS } from "./extract";

describe("adaptMcpResult", () => {
  it("keeps the text a tool returned", () => {
    const data = adaptMcpResult({ ok: true, content: "Two orders are blocked." });
    expect(data.text).toEqual(["Two orders are blocked."]);
    expect(data.tables).toEqual([]);
  });

  it("drops empty text rather than carrying a blank line", () => {
    expect(adaptMcpResult({ ok: true, content: "" }).text).toEqual([]);
  });

  it("turns an array of objects into a table with columns from the rows", () => {
    const data = adaptMcpResult({
      ok: true,
      content: "",
      structured: { blocked: [{ id: "A-1", vehicle: "V-9" }, { id: "A-2", vehicle: "V-3" }] },
    });

    expect(data.tables).toHaveLength(1);
    expect(data.tables[0]?.id).toBe("blocked");
    expect(data.tables[0]?.columns.map((column) => column.key)).toEqual(["id", "vehicle"]);
    expect(data.tables[0]?.rows).toEqual([
      { id: "A-1", vehicle: "V-9" },
      { id: "A-2", vehicle: "V-3" },
    ]);
    expect(data.tables[0]?.rowCount).toBe(2);
    expect(data.tables[0]?.truncated).toBe(false);
  });

  it("unions keys across rows, so a column present on only some rows survives", () => {
    const data = adaptMcpResult({
      ok: true,
      content: "",
      structured: { rows: [{ id: "A-1" }, { id: "A-2", note: "late" }] },
    });

    expect(data.tables[0]?.columns.map((column) => column.key)).toEqual(["id", "note"]);
  });

  it("caps rows at the same limit as a screen extraction, and says so", () => {
    const rows = Array.from({ length: MAX_EXTRACTED_ROWS + 40 }, (_, index) => ({ id: index }));
    const data = adaptMcpResult({ ok: true, content: "", structured: { rows } });

    expect(data.tables[0]?.rows).toHaveLength(MAX_EXTRACTED_ROWS);
    expect(data.tables[0]?.rowCount).toBe(MAX_EXTRACTED_ROWS + 40);
    expect(data.tables[0]?.truncated).toBe(true);
  });

  it("turns scalars into facts, so a single number can still be cited", () => {
    const data = adaptMcpResult({
      ok: true,
      content: "",
      structured: { blockedCount: 4, region: "north", healthy: true },
    });

    expect(data.facts).toEqual([
      { label: "blockedCount", value: "4" },
      { label: "region", value: "north" },
      { label: "healthy", value: "true" },
    ]);
  });

  it("renders a nested object as a fact rather than dropping it silently", () => {
    const data = adaptMcpResult({
      ok: true,
      content: "",
      structured: { window: { from: "2026-01-01", to: "2026-02-01" } },
    });

    expect(data.facts).toEqual([
      { label: "window", value: '{"from":"2026-01-01","to":"2026-02-01"}' },
    ]);
  });

  it("keeps an array of scalars as a fact, not a table of nothing", () => {
    const data = adaptMcpResult({ ok: true, content: "", structured: { ids: ["A-1", "A-2"] } });

    expect(data.tables).toEqual([]);
    expect(data.facts).toEqual([{ label: "ids", value: "A-1, A-2" }]);
  });

  it("ignores null, which JSON has and the extracted shape does not", () => {
    const data = adaptMcpResult({ ok: true, content: "", structured: { note: null } });
    expect(data.facts).toEqual([]);
  });

  it("never produces stats or charts — those are screen shapes, not tool shapes", () => {
    const data = adaptMcpResult({
      ok: true,
      content: "text",
      structured: { rows: [{ id: 1 }], count: 1 },
    });

    expect(data.stats).toEqual([]);
    expect(data.charts).toEqual([]);
  });
});
