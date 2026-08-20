"use client";

import NextLink from "next/link";
import { useState } from "react";
import { useRender } from "../context";
import type { Renderer } from "../kinds";
import { resolveLink } from "../links";

/**
 * The three components that make something happen.
 *
 * `Button` and `MenuButton` fire satellite actions through the hub's proxy.
 * `Link` navigates, and is the only component in the vocabulary that can put a
 * satellite-supplied string somewhere the browser will act on — see `links.ts`
 * for why that resolution is a separate, tested function rather than a template
 * hole here.
 */

export const Button: Renderer<"Button"> = ({ props }) => {
  const { dispatch, busy } = useRender();
  const action = props.action;

  return (
    <button
      type="button"
      className="r-button"
      data-variant={props.variant ?? "secondary"}
      data-size={props.size ?? "md"}
      // A button with no action does nothing, so it says so rather than
      // looking live and swallowing the click.
      disabled={props.disabled === true || busy || action === undefined}
      onClick={() => {
        if (action === undefined) return;
        dispatch({
          actionId: action.actionId,
          payload: { ...action.payload },
          ...(props.confirm === undefined ? {} : { confirm: props.confirm }),
        });
      }}
    >
      {props.label}
    </button>
  );
};

export const Link: Renderer<"Link"> = ({ props }) => {
  const ctx = useRender();
  const link = resolveLink(props, {
    currentSatelliteId: ctx.satelliteId,
    allowedSatelliteIds: ctx.allowedSatelliteIds,
  });

  if (link.kind === "inert") {
    // Rendered as plain text with the reason in the title: a dead anchor still
    // looks clickable, and silently dropping the label loses content the
    // satellite meant to show.
    return (
      <span className="r-link" data-inert="" title={link.reason}>
        {props.label}
      </span>
    );
  }

  if (link.kind === "external") {
    return (
      <a
        className="r-link"
        href={link.href}
        data-external=""
        target="_blank"
        // `noopener` is the one that matters: without it the opened page can
        // reach back through `window.opener` and navigate the portal.
        rel="noopener noreferrer"
      >
        {props.label}
        <span className="r-externalMark" aria-label=" (opens in a new tab)">
          ↗
        </span>
      </a>
    );
  }

  return (
    <NextLink className="r-link" href={link.href} prefetch={false}>
      {props.label}
    </NextLink>
  );
};

export const MenuButton: Renderer<"MenuButton"> = ({ props }) => {
  const ctx = useRender();
  const [open, setOpen] = useState(false);

  return (
    <div className="r-menu">
      <button
        type="button"
        className="r-button"
        data-variant="secondary"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((was) => !was)}
      >
        {props.label} <span aria-hidden="true">▾</span>
      </button>

      {open && (
        <ul className="r-menuList" role="menu">
          {props.items.map((item, index) => (
            <li key={`${item.label}-${index}`} role="none">
              <MenuItem item={item} onDone={() => setOpen(false)} ctx={ctx} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

function MenuItem({
  item,
  onDone,
  ctx,
}: {
  item: { label: string; action?: { actionId: string; payload?: Record<string, unknown> | undefined } | undefined; screenId?: string | undefined };
  onDone: () => void;
  ctx: ReturnType<typeof useRender>;
}) {
  if (item.screenId !== undefined) {
    const link = resolveLink(
      { screenId: item.screenId },
      { currentSatelliteId: ctx.satelliteId, allowedSatelliteIds: ctx.allowedSatelliteIds },
    );
    return link.kind === "internal" ? (
      <NextLink className="r-menuItem" role="menuitem" href={link.href} prefetch={false}>
        {item.label}
      </NextLink>
    ) : (
      <span className="r-menuItem" data-inert="" title={link.kind === "inert" ? link.reason : ""}>
        {item.label}
      </span>
    );
  }

  const action = item.action;
  return (
    <button
      type="button"
      className="r-menuItem"
      role="menuitem"
      disabled={action === undefined || ctx.busy}
      onClick={() => {
        onDone();
        if (action !== undefined) {
          ctx.dispatch({ actionId: action.actionId, payload: { ...action.payload } });
        }
      }}
    >
      {item.label}
    </button>
  );
}
