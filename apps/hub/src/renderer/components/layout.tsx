"use client";

import { useState } from "react";
import { NestedHeadings, useHeadingLevel } from "../context";
import type { Renderer } from "../kinds";

/**
 * The eight layout components.
 *
 * Every one of them turns a semantic prop into a `data-` attribute and lets
 * `renderer.css` decide what it means. Nothing here computes a colour, a
 * spacing value or a font — that is the whole bargain: a satellite says
 * `gap: "lg"` and the hub decides how big large is, so changing it changes
 * every satellite at once without any of them being redeployed.
 *
 * The one exception is `Grid`, and it is explained where it happens.
 */

/** Renders a container's own title at whatever level the tree has reached. */
function Title({ text }: { text: string }) {
  const level = useHeadingLevel();
  const Tag = `h${level}` as "h2" | "h3" | "h4" | "h5" | "h6";
  return <Tag className="r-title">{text}</Tag>;
}

export const Page: Renderer<"Page"> = ({ props, children }) => (
  <div className="r-page">
    {/* The screen's own title is the page's `h1`, from the response envelope.
        A `Page.title` is a second, lesser title inside it — rendered at the
        current level rather than promoted, so the heading order stays sane. */}
    {props.title !== undefined && <Title text={props.title} />}
    <NestedHeadings when={props.title !== undefined}>{children}</NestedHeadings>
  </div>
);

export const Section: Renderer<"Section"> = ({ props, children }) => {
  // A collapsible section always renders a heading — its own `<summary>` —
  // even when the satellite gave it no title.
  const hasTitle = props.title !== undefined || props.collapsible === true;

  const body = (
    <>
      {props.description !== undefined && <p className="r-muted">{props.description}</p>}
      <NestedHeadings when={hasTitle}>{children}</NestedHeadings>
    </>
  );

  // `<details>` rather than a click handler: collapsing works before hydration,
  // survives printing, and is findable by the browser's own in-page search.
  if (props.collapsible === true) {
    return (
      <details className="r-section" open>
        <summary className="r-summary">{props.title ?? "Details"}</summary>
        {body}
      </details>
    );
  }

  return (
    <section className="r-section">
      {props.title !== undefined && <Title text={props.title} />}
      {body}
    </section>
  );
};

export const Stack: Renderer<"Stack"> = ({ props, children }) => (
  <div
    className="r-stack"
    data-direction={props.direction ?? "column"}
    data-gap={props.gap ?? "md"}
    data-align={props.align ?? "stretch"}
    data-wrap={props.wrap === true ? "" : undefined}
  >
    {children}
  </div>
);

/**
 * The one place the renderer computes a value rather than naming one.
 *
 * A column count is data, not presentation — the hub still owns the track
 * sizing, the gap and the breakpoints. It is clamped because the catalog
 * carries no range constraints on purpose (structured outputs reject them), so
 * `columns: 0` and `columns: 10000` are both things a producer can legally
 * send, and CSS grid accepts neither gracefully.
 */
const MAX_GRID_COLUMNS = 12;

export const Grid: Renderer<"Grid"> = ({ props, children }) => {
  const columns = Math.min(Math.max(Math.trunc(props.columns) || 1, 1), MAX_GRID_COLUMNS);
  return (
    <div
      className="r-grid"
      data-gap={props.gap ?? "md"}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {children}
    </div>
  );
};

export const Card: Renderer<"Card"> = ({ props, children }) => (
  <div className="r-card" data-tone={props.tone ?? "neutral"}>
    {props.title !== undefined && <Title text={props.title} />}
    <NestedHeadings when={props.title !== undefined}>{children}</NestedHeadings>
  </div>
);

export const Divider: Renderer<"Divider"> = ({ props }) => (
  <hr className="r-divider" data-spacing={props.spacing ?? "md"} />
);

export const Tabs: Renderer<"Tabs"> = ({ props, children }) => {
  const first = props.tabs[0]?.id;
  const declared = props.activeId;
  // A satellite naming a tab that is not in its own list would otherwise show
  // an empty panel with every tab looking unselected.
  const initial =
    declared !== undefined && props.tabs.some((tab) => tab.id === declared) ? declared : first;
  const [active, setActive] = useState(initial);

  if (first === undefined) return null;

  const index = props.tabs.findIndex((tab) => tab.id === active);
  const panel = children[index === -1 ? 0 : index];

  return (
    <div className="r-tabs">
      <div className="r-tablist" role="tablist">
        {props.tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            className="r-tab"
            aria-selected={tab.id === active}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {/* A tab label is a control, not a heading, so the panel keeps the
          level the tab strip was at. */}
      <div className="r-tabpanel" role="tabpanel">
        {panel}
      </div>
    </div>
  );
};

export const Modal: Renderer<"Modal"> = ({ props, children }) => {
  const [open, setOpen] = useState(props.open === true);
  if (!open) return null;

  return (
    <div className="r-modalBackdrop">
      <div className="r-modal" role="dialog" aria-modal="true" aria-label={props.title} data-size={props.size ?? "md"}>
        <div className="r-modalHead">
          <Title text={props.title} />
          <button type="button" className="r-iconButton" onClick={() => setOpen(false)} aria-label="Close">
            ×
          </button>
        </div>
        <NestedHeadings>{children}</NestedHeadings>
      </div>
    </div>
  );
};
