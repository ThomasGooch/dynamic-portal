"use client";

import NextLink from "next/link";
import { useRender } from "../context";
import { formatValue } from "../format";
import type { Renderer, PropsOf } from "../kinds";
import { resolveLink } from "../links";
import { SourceMark } from "./display";

/**
 * The component most satellites spend most of their time in.
 *
 * Two things here are worth stating plainly.
 *
 * **Cells are satellite data, not catalog vocabulary.** A row is
 * `Record<string, unknown>`, so every cell goes through `formatValue`, which
 * has an answer for every JavaScript value rather than the three it expects.
 *
 * **Paging is navigation, not state.** The next page is a link to the same
 * screen with a different `page` param, which the hub re-fetches through the
 * proxy. That keeps a paged table deep-linkable and back-button-correct, and it
 * is why the satellite never has to implement paging in its own UI — it only
 * has to read the param it declared.
 */

type Column = PropsOf<"Table">["columns"][number];

export const Table: Renderer<"Table"> = ({ props }) => {
  const rows = props.rows ?? [];

  if (rows.length === 0) {
    return (
      <div className="r-empty">
        <strong>{props.emptyMessage ?? "Nothing to show"}</strong>
      </div>
    );
  }

  return (
    <div className="r-tableWrap">
      <table className="r-table">
        <thead>
          <tr>
            {props.columns.map((column) => (
              <th key={column.key} data-align={column.align ?? "start"} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowKey(row, props.rowAction?.paramKey, rowIndex)}>
              {props.columns.map((column, columnIndex) => (
                <td key={column.key} data-align={column.align ?? "start"}>
                  <Cell
                    row={row}
                    column={column}
                    // Only the first column becomes the row's link: a whole-row
                    // click handler is not a link, so it loses middle-click,
                    // copy-link, and the address bar — the deep-linking this
                    // architecture exists to keep.
                    linkTo={columnIndex === 0 ? props.rowAction : undefined}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="r-tableFoot">
        {props.source !== undefined && <SourceMark toolCallId={props.source.toolCallId} />}
        <Pager {...props} />
      </div>
    </div>
  );
};

function rowKey(row: Record<string, unknown>, paramKey: string | undefined, index: number): string {
  const candidate = paramKey === undefined ? undefined : row[paramKey];
  return typeof candidate === "string" || typeof candidate === "number"
    ? String(candidate)
    : `row-${index}`;
}

function Cell({
  row,
  column,
  linkTo,
}: {
  row: Record<string, unknown>;
  column: Column;
  linkTo?: { screenId: string; paramKey: string } | undefined;
}) {
  const ctx = useRender();
  const value = row[column.key];
  const tone = column.toneKey === undefined ? undefined : toTone(row[column.toneKey]);
  const text = formatValue(value, column.as);

  const body =
    column.as === "badge" ? (
      <span className="r-badge" data-tone={tone ?? "neutral"}>
        {text}
      </span>
    ) : column.as === "code" ? (
      <code>{text}</code>
    ) : (
      text
    );

  if (linkTo === undefined) return <>{body}</>;

  const param = row[linkTo.paramKey];
  if (typeof param !== "string" && typeof param !== "number") {
    // The row has no value for the key the satellite said identifies it. A
    // link to `?id=undefined` looks navigable and is not.
    return <>{body}</>;
  }

  const link = resolveLink(
    { screenId: linkTo.screenId, params: { [linkTo.paramKey]: String(param) } },
    { currentSatelliteId: ctx.satelliteId, allowedSatelliteIds: ctx.allowedSatelliteIds },
  );

  return link.kind === "internal" ? (
    <NextLink href={link.href} prefetch={false}>
      {body}
    </NextLink>
  ) : (
    <>{body}</>
  );
}

const TONES = new Set(["neutral", "muted", "info", "success", "warning", "danger"]);

/** A tone column holds satellite data, so it may hold anything. */
function toTone(value: unknown): string | undefined {
  return typeof value === "string" && TONES.has(value) ? value : undefined;
}

function Pager({ page, pageSize, total, dataSource }: PropsOf<"Table">) {
  const ctx = useRender();

  // Paging needs all three: which page, how big, and how many. With any of them
  // missing the hub cannot say whether a next page exists, and a Next button
  // that might lead nowhere is worse than none.
  if (page === undefined || pageSize === undefined || total === undefined) return null;
  if (pageSize <= 0 || total <= 0) return null;

  const lastPage = Math.max(Math.ceil(total / pageSize), 1);
  const current = Math.min(Math.max(page, 1), lastPage);

  const href = (target: number): string | undefined => {
    const base =
      dataSource === undefined
        ? { screenId: ctx.screenId, params: { ...ctx.params } }
        : {
            screenId: dataSource.screenId,
            ...(dataSource.satelliteId === undefined ? {} : { satelliteId: dataSource.satelliteId }),
            params: { ...dataSource.params },
          };
    const link = resolveLink(
      { ...base, params: { ...base.params, page: String(target) } },
      { currentSatelliteId: ctx.satelliteId, allowedSatelliteIds: ctx.allowedSatelliteIds },
    );
    return link.kind === "internal" ? link.href : undefined;
  };

  const previous = current > 1 ? href(current - 1) : undefined;
  const next = current < lastPage ? href(current + 1) : undefined;

  return (
    <nav className="r-pager" aria-label="Pagination">
      {previous === undefined ? (
        <span className="r-pagerDisabled">Previous</span>
      ) : (
        <NextLink href={previous} prefetch={false}>
          Previous
        </NextLink>
      )}
      <span className="r-pagerStatus">
        Page {current} of {lastPage} · {total} total
      </span>
      {next === undefined ? (
        <span className="r-pagerDisabled">Next</span>
      ) : (
        <NextLink href={next} prefetch={false}>
          Next
        </NextLink>
      )}
    </nav>
  );
}
