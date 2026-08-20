import { MAX_EXTRACTED_ROWS, type ExtractedData, type ExtractedFact, type ExtractedTable } from "./extract";

/**
 * An MCP tool's result, in the shape the grounding validator checks against.
 *
 * `extract.ts` recovers data from a rendered screen: it walks a UI tree, finds
 * the table component, and reconstructs rows from the presentation of them.
 * That works, and it is what lets a satellite with no MCP server still answer
 * an agent — but it is a reconstruction, limited to what a screen chose to
 * show, in the order a screen chose to show it.
 *
 * A tool that returns `structuredContent` skips all of that. The satellite
 * hands over the data it already had, so this file's whole job is renaming
 * shapes rather than inferring them. That difference is the clearest single
 * answer to "what does hosting an MCP server buy a satellite over the shim".
 *
 * The result still lands in `ExtractedData`, because grounding must not care
 * where a figure came from. A `StatTile` citing an MCP tool is checked exactly
 * as strictly as one citing a screen — otherwise "host an MCP server" would
 * also read as "opt out of the validator", which is not a trade this hub offers.
 */

export interface McpResultLike {
  readonly ok: true;
  readonly content: string;
  readonly structured?: Record<string, unknown>;
}

export function adaptMcpResult(result: McpResultLike): ExtractedData {
  const tables: ExtractedTable[] = [];
  const facts: ExtractedFact[] = [];

  for (const [key, value] of Object.entries(result.structured ?? {})) {
    if (isRowArray(value)) {
      tables.push(toTable(key, value));
      continue;
    }

    // `null` is JSON's, not the extracted shape's. Rendering it as the string
    // "null" would put a fact on the screen that the satellite did not state.
    if (value === null || value === undefined) continue;

    facts.push({ label: key, value: render(value) });
  }

  return {
    tables,
    // Deliberately empty. A stat and a chart are things a *screen* has — an
    // extraction finds them because a satellite laid them out. Inventing either
    // from a tool result would be the gateway deciding how data should look,
    // which is the hub's job at render time and nobody's job here.
    stats: [],
    facts,
    charts: [],
    text: result.content === "" ? [] : [result.content],
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An array of objects is a table; an array of strings is a list, and stays a fact. */
const isRowArray = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) && value.length > 0 && value.every(isObject);

function toTable(key: string, rows: readonly Record<string, unknown>[]): ExtractedTable {
  // Unioned rather than taken from the first row: a tool that omits a field
  // when it is empty would otherwise lose that column entirely, and a column
  // that vanishes depending on the data is worse than one that is sometimes
  // blank. Insertion order is preserved, so the satellite's field order stands.
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].map((column) => ({
    key: column,
    label: column,
  }));

  // The same cap the screen path uses, for the same reason: a tool result goes
  // into a model's context, and an uncapped one is a satellite deciding how
  // much of the budget it gets.
  const capped = rows.slice(0, MAX_EXTRACTED_ROWS);

  return {
    id: key,
    columns,
    rows: capped,
    rowCount: rows.length,
    truncated: capped.length < rows.length,
  };
}

function render(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // A list of ids reads as a list; an object reads as JSON. Both keep the value
  // visible to grounding, which compares against the rendered string.
  if (Array.isArray(value)) return value.map(render).join(", ");
  return JSON.stringify(value);
}
