import { FlatSpecSchema, type FlatSpec } from "@portal/catalog";
import type { ExtractedData, ExtractedTable } from "@portal/mcp-gateway";
import { MUST_CITE_A_SOURCE } from "./schema";

/**
 * Where a model's screen meets the facts.
 *
 * PLAN.md states the rule as "the hub rejects ungrounded numbers", and there
 * are two halves to keeping it. The schema removes `Table.rows` and
 * `Chart.data` so a model has nowhere to write data; this file puts the data
 * back, from the tool call the node named. A fabricated row is not caught here
 * — it was never possible.
 *
 * What *is* caught here is the softer failure. `StatTile.value` is a string the
 * model composes, so citing a real call proves it looked something up and
 * nothing more. The value has to actually appear in that call's result, or the
 * tile is refused. That is the difference between a citation and grounding, and
 * it is the whole reason this is a validator rather than a prompt.
 */

export interface ToolCallRecord {
  readonly toolCallId: string;
  readonly data: ExtractedData;
}

export interface GroundingIssue {
  readonly elementId: string;
  readonly message: string;
}

export type GroundingResult =
  | { readonly ok: true; readonly spec: FlatSpec }
  | { readonly ok: false; readonly issues: readonly GroundingIssue[] };

export function groundSpec(spec: FlatSpec, calls: readonly ToolCallRecord[]): GroundingResult {
  const byId = new Map(calls.map((call) => [call.toolCallId, call]));
  const issues: GroundingIssue[] = [];

  const elements = spec.elements.map((element) => {
    if (!MUST_CITE_A_SOURCE.includes(element.type as (typeof MUST_CITE_A_SOURCE)[number])) {
      return element;
    }

    const props = (element.props ?? {}) as Record<string, unknown>;
    const toolCallId = (props["source"] as { toolCallId?: unknown } | undefined)?.toolCallId;

    if (typeof toolCallId !== "string") {
      issues.push({ elementId: element.id, message: `${element.type} cites no tool call` });
      return element;
    }

    const call = byId.get(toolCallId);
    if (call === undefined) {
      // A model that invents a tool call id would otherwise get a table
      // rendered from whatever happened to be lying around.
      issues.push({
        elementId: element.id,
        message: `${element.type} cites tool call "${toolCallId}", which did not happen`,
      });
      return element;
    }

    switch (element.type) {
      case "Table":
        return withRows(element, props, call.data, issues);
      case "Chart":
        return withData(element, props, call.data, issues);
      default:
        checkValue(element.id, props, call.data, issues);
        return element;
    }
  });

  if (issues.length > 0) return { ok: false, issues };

  // Substitution puts `rows` back on a node the model was not allowed to write
  // them on, so the result is re-validated rather than trusted.
  const parsed = FlatSpecSchema.safeParse({ ...spec, elements });
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        elementId: String(issue.path[1] ?? "(spec)"),
        message: issue.message,
      })),
    };
  }

  return { ok: true, spec: parsed.data };
}

type Element = FlatSpec["elements"][number];

function withRows(
  element: Element,
  props: Record<string, unknown>,
  data: ExtractedData,
  issues: GroundingIssue[],
): Element {
  const keys = columnKeys(props);
  const table = pickTable(element.id, keys, data, issues);
  if (table === undefined) return element;

  // Only the columns the model asked for. The extracted table may be wider than
  // the screen it composed.
  const rows = table.rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (Object.hasOwn(row, key)) out[key] = row[key];
    }
    return out;
  });

  return { ...element, props: { ...props, rows } };
}

function withData(
  element: Element,
  props: Record<string, unknown>,
  data: ExtractedData,
  issues: GroundingIssue[],
): Element {
  const xKey = typeof props["xKey"] === "string" ? props["xKey"] : undefined;
  const seriesKeys = Array.isArray(props["series"])
    ? props["series"]
        .map((entry) => (entry as { key?: unknown }).key)
        .filter((key): key is string => typeof key === "string")
    : [];
  if (xKey === undefined) {
    issues.push({ elementId: element.id, message: "Chart names no x axis" });
    return element;
  }

  const needed = [xKey, ...seriesKeys];

  // A chart the cited call already drew, matched on the axis it is drawn
  // against.
  const chart = data.charts.find(
    (candidate) =>
      candidate.xKey === xKey &&
      seriesKeys.every((key) => candidate.series.some((entry) => entry.key === key)),
  );
  if (chart !== undefined) {
    return { ...element, props: { ...props, data: project(chart.data, needed) } };
  }

  // Otherwise a table that happens to carry every key the chart needs — which
  // is how a list becomes a chart without the model inventing the points.
  const table = data.tables.filter((candidate) =>
    needed.every((key) => candidate.columns.some((column) => column.key === key)),
  );
  if (table.length === 1) {
    return { ...element, props: { ...props, data: project((table[0] as ExtractedTable).rows, needed) } };
  }

  issues.push({
    elementId: element.id,
    message:
      table.length > 1
        ? `Chart could be drawn from more than one result in this tool call`
        : `Chart needs ${needed.join(", ")}, which this tool call does not supply`,
  });
  return element;
}

function checkValue(
  elementId: string,
  props: Record<string, unknown>,
  data: ExtractedData,
  issues: GroundingIssue[],
): void {
  const value = props["value"];
  if (typeof value !== "string") return;

  if (!reported(data).has(value)) {
    issues.push({
      elementId,
      message: `StatTile shows "${value}", which does not appear in the tool call it cites`,
    });
  }
}

/** Every value the cited call actually reported, as the strings a tile shows. */
function reported(data: ExtractedData): Set<string> {
  const values = new Set<string>();
  for (const stat of data.stats) values.add(stat.value);
  for (const fact of data.facts) values.add(fact.value);
  for (const table of data.tables) {
    for (const row of table.rows) {
      // Cells keep their JSON types; a tile's value is a string, so both forms
      // count as the same reading.
      for (const cell of Object.values(row)) values.add(scalar(cell));
    }
  }
  for (const chart of data.charts) {
    for (const point of chart.data) {
      for (const cell of Object.values(point)) values.add(scalar(cell));
    }
  }
  values.delete("");
  return values;
}

const scalar = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";

function columnKeys(props: Record<string, unknown>): string[] {
  return Array.isArray(props["columns"])
    ? props["columns"]
        .map((column) => (column as { key?: unknown }).key)
        .filter((key): key is string => typeof key === "string")
    : [];
}

function pickTable(
  elementId: string,
  keys: readonly string[],
  data: ExtractedData,
  issues: GroundingIssue[],
): ExtractedTable | undefined {
  const usable = data.tables.filter((table) =>
    keys.every((key) => table.columns.some((column) => column.key === key)),
  );

  if (usable.length === 1) return usable[0];

  if (usable.length === 0) {
    // Citing a real call is not the same as citing the right one. A column the
    // result has no key for would render as a page of dashes.
    const missing = keys.filter(
      (key) => !data.tables.some((table) => table.columns.some((column) => column.key === key)),
    );
    issues.push({
      elementId,
      message: `Table needs ${(missing.length > 0 ? missing : keys).join(", ")}, which this tool call does not supply`,
    });
    return undefined;
  }

  // Several would fit. If the node's own id names one of them, the model was
  // explicit about which; otherwise picking is a guess, and the wrong guess is
  // a screen of plausible numbers from the wrong query.
  const named = usable.find((table) => table.id === elementId);
  if (named !== undefined) return named;

  issues.push({
    elementId,
    message: `Table could be filled from more than one result in this tool call; name the one you mean`,
  });
  return undefined;
}

function project(
  rows: readonly Record<string, unknown>[],
  keys: readonly string[],
): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (Object.hasOwn(row, key)) out[key] = row[key];
    }
    return out;
  });
}
