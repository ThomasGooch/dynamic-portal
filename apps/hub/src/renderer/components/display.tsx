"use client";

import { useHeadingLevel, useRender } from "../context";
import { formatValue } from "../format";
import type { Renderer } from "../kinds";

/**
 * Display components: the read-only half of the vocabulary.
 *
 * `Table` and `Chart` live in their own files — they are the two that carry
 * satellite *data* rather than satellite *declarations*, and both need more
 * care than a `data-` attribute.
 */

/**
 * Provenance marker.
 *
 * Rendered wherever a node carries `source`, so an agent-composed number is
 * visibly derived rather than authoritative. In M1 nothing sets it; the marker
 * exists now because the rule PLAN.md states — every displayed fact traces to
 * the tool call behind it — is only credible if it is enforced from the start
 * rather than added once there is something to hide.
 */
export function SourceMark({ toolCallId }: { toolCallId: string }) {
  return (
    <abbr className="r-source" title={`Derived from tool call ${toolCallId}`}>
      derived
    </abbr>
  );
}

export const Heading: Renderer<"Heading"> = ({ props }) => {
  const base = useHeadingLevel();
  // `level` is relative intent, not an absolute tag. A satellite composes a
  // section without knowing how deep the hub nested it, so treating its `1` as
  // `<h1>` would put a second top-level heading under the screen title and
  // break the order screen readers navigate by.
  const level = Math.min(base + (props.level ?? 1) - 1, 6);
  const Tag = `h${level}` as "h2" | "h3" | "h4" | "h5" | "h6";
  return <Tag className="r-heading">{props.text}</Tag>;
};

export const Text: Renderer<"Text"> = ({ props }) => (
  <p
    className="r-text"
    data-tone={props.tone ?? "neutral"}
    data-size={props.size ?? "md"}
    data-emphasis={props.emphasis === true ? "" : undefined}
  >
    {props.text}
  </p>
);

export const Badge: Renderer<"Badge"> = ({ props }) => (
  <span className="r-badge" data-tone={props.tone ?? "neutral"}>
    {props.label}
  </span>
);

export const StatTile: Renderer<"StatTile"> = ({ props }) => (
  <div className="r-stat" data-tone={props.tone ?? "neutral"}>
    <span className="r-statLabel">{props.label}</span>
    <strong className="r-statValue">{props.value}</strong>
    {props.caption !== undefined && <span className="r-statCaption">{props.caption}</span>}
    {props.source !== undefined && <SourceMark toolCallId={props.source.toolCallId} />}
  </div>
);

export const KeyValueList: Renderer<"KeyValueList"> = ({ props }) => (
  <dl className="r-kv">
    {props.items.map((item, index) => (
      <div className="r-kvRow" key={`${item.label}-${index}`}>
        <dt>{item.label}</dt>
        <dd data-tone={item.tone ?? "neutral"}>
          {item.as === "badge" ? (
            <span className="r-badge" data-tone={item.tone ?? "neutral"}>
              {formatValue(item.value, item.as)}
            </span>
          ) : item.as === "code" ? (
            <code>{formatValue(item.value, item.as)}</code>
          ) : (
            formatValue(item.value, item.as)
          )}
        </dd>
      </div>
    ))}
  </dl>
);

export const Alert: Renderer<"Alert"> = ({ props }) => (
  <div
    className="r-alert"
    data-level={props.level}
    // Only failures interrupt a screen reader mid-task; an informational alert
    // that seized focus would be worse than one that waits its turn.
    role={props.level === "error" ? "alert" : "status"}
  >
    {props.title !== undefined && <strong>{props.title}</strong>}
    <span>{props.message}</span>
  </div>
);

export const EmptyState: Renderer<"EmptyState"> = ({ props }) => {
  const { dispatch, busy } = useRender();
  const action = props.action;

  return (
    <div className="r-empty">
      <strong>{props.title}</strong>
      {props.message !== undefined && <p className="r-muted">{props.message}</p>}
      {action !== undefined && (
        <button
          type="button"
          className="r-button"
          data-variant="secondary"
          disabled={busy}
          onClick={() => dispatch({ actionId: action.actionId, payload: { ...action.payload } })}
        >
          {props.actionLabel ?? "Continue"}
        </button>
      )}
    </div>
  );
};

export const Timeline: Renderer<"Timeline"> = ({ props }) => (
  <ol className="r-timeline">
    {props.items.map((item, index) => (
      <li key={`${item.timestamp}-${index}`} data-tone={item.tone ?? "neutral"}>
        <time className="r-timelineWhen">{formatValue(item.timestamp, "datetime")}</time>
        <strong>{item.label}</strong>
        {item.description !== undefined && <p className="r-muted">{item.description}</p>}
      </li>
    ))}
  </ol>
);
