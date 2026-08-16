import type { UiNode } from "@portal/protocol";

/**
 * A screen, as data rather than as layout.
 *
 * A read tool that returned the UI tree would spend most of a model's context
 * on `Stack` and `Section` nodes it cannot use, and would invite it to reason
 * about presentation. What an agent asked "which orders are pending" needs is
 * the rows.
 *
 * Two rules make this safe to send onward.
 *
 * **Only declared columns survive.** A satellite's rows routinely carry fields
 * the table does not show — `statusTone` for the renderer, ids it uses to build
 * links. Those were never shown to a human either, so they are not shown to a
 * model. This is the narrowest useful reading of the redaction policy the
 * gateway owns, and the place to widen it if a real one arrives.
 *
 * **Truncation is reported.** Silently cutting rows is the worst outcome
 * available: the model answers "3 orders" for a page of 3,000 and sounds
 * certain. Saying so lets it narrow the question instead.
 */

/** Enough for a screen a human was expected to read; far short of a data dump. */
export const MAX_EXTRACTED_ROWS = 200;

export interface ExtractedColumn {
  readonly key: string;
  readonly label: string;
}

export interface ExtractedTable {
  readonly id?: string;
  readonly columns: readonly ExtractedColumn[];
  readonly rows: readonly Record<string, unknown>[];
  /** How many rows the screen actually held, before any cap. */
  readonly rowCount: number;
  readonly truncated: boolean;
}

export interface ExtractedStat {
  readonly label: string;
  readonly value: string;
  readonly caption?: string;
}

export interface ExtractedFact {
  readonly label: string;
  readonly value: string;
}

export interface ExtractedChart {
  readonly kind: string;
  readonly xKey: string;
  readonly series: readonly ExtractedColumn[];
  readonly data: readonly Record<string, unknown>[];
  readonly truncated: boolean;
}

export interface ExtractedData {
  readonly tables: readonly ExtractedTable[];
  readonly stats: readonly ExtractedStat[];
  readonly facts: readonly ExtractedFact[];
  readonly charts: readonly ExtractedChart[];
  /** Headings, prose, alerts — the parts of an answer that are not a number. */
  readonly text: readonly string[];
}

export function extractData(root: UiNode): ExtractedData {
  const tables: ExtractedTable[] = [];
  const stats: ExtractedStat[] = [];
  const facts: ExtractedFact[] = [];
  const charts: ExtractedChart[] = [];
  const text: string[] = [];

  // Iterative, and pushed in reverse so children are visited in document order.
  // Screens arrive bounded at MAX_NODE_DEPTH, but that bound is enforced
  // elsewhere and this also walks patch subtrees; not depending on it means the
  // two are not coupled by an assumption nobody restates.
  const stack: UiNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop() as UiNode;
    const props = (node.props ?? {}) as Record<string, unknown>;

    switch (node.type) {
      case "Table": {
        const table = readTable(node.id, props);
        if (table !== undefined) tables.push(table);
        break;
      }
      case "StatTile": {
        const label = str(props["label"]);
        const value = str(props["value"]);
        if (label !== undefined && value !== undefined) {
          const caption = str(props["caption"]);
          stats.push({ label, value, ...(caption === undefined ? {} : { caption }) });
        }
        break;
      }
      case "KeyValueList": {
        for (const item of arr(props["items"])) {
          const label = str(rec(item)?.["label"]);
          const value = str(rec(item)?.["value"]);
          if (label !== undefined && value !== undefined) facts.push({ label, value });
        }
        break;
      }
      case "Chart": {
        const chart = readChart(props);
        if (chart !== undefined) charts.push(chart);
        break;
      }
      case "Heading":
      case "Text": {
        const value = str(props["text"]);
        if (value !== undefined) text.push(value);
        break;
      }
      case "Badge": {
        const label = str(props["label"]);
        if (label !== undefined) text.push(label);
        break;
      }
      case "Alert":
      case "EmptyState": {
        const title = str(props["title"]);
        const message = str(props["message"]);
        const line = [title, message].filter((part) => part !== undefined).join(": ");
        if (line !== "") text.push(line);
        break;
      }
      default:
        break;
    }

    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i] as UiNode);
  }

  return { tables, stats, facts, charts, text };
}

function readTable(id: string | undefined, props: Record<string, unknown>): ExtractedTable | undefined {
  const columns: ExtractedColumn[] = [];
  for (const entry of arr(props["columns"])) {
    const key = str(rec(entry)?.["key"]);
    const label = str(rec(entry)?.["label"]);
    if (key !== undefined && label !== undefined) columns.push({ key, label });
  }
  if (columns.length === 0) return undefined;

  const source = arr(props["rows"]);
  const rows = source.slice(0, MAX_EXTRACTED_ROWS).map((row) => {
    const record = rec(row) ?? {};
    // Declared columns only. A row's other fields were never shown to a human
    // either — see the note at the top of this file.
    const out: Record<string, unknown> = {};
    for (const column of columns) {
      if (column.key in record) out[column.key] = record[column.key];
    }
    return out;
  });

  return {
    ...(id === undefined ? {} : { id }),
    columns,
    rows,
    rowCount: source.length,
    truncated: source.length > rows.length,
  };
}

function readChart(props: Record<string, unknown>): ExtractedChart | undefined {
  const kind = str(props["kind"]);
  const xKey = str(props["xKey"]);
  if (kind === undefined || xKey === undefined) return undefined;

  const series: ExtractedColumn[] = [];
  for (const entry of arr(props["series"])) {
    const key = str(rec(entry)?.["key"]);
    const label = str(rec(entry)?.["label"]);
    if (key !== undefined && label !== undefined) series.push({ key, label });
  }

  const source = arr(props["data"]);
  const points = source.slice(0, MAX_EXTRACTED_ROWS).map((point) => {
    const record = rec(point) ?? {};
    const out: Record<string, unknown> = {};
    if (xKey in record) out[xKey] = record[xKey];
    for (const entry of series) {
      if (entry.key in record) out[entry.key] = record[entry.key];
    }
    return out;
  });

  return { kind, xKey, series, data: points, truncated: source.length > points.length };
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const arr = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
