"use client";

import { createContext, useContext } from "react";

/**
 * What every rendered node needs to know that is not in its own props.
 *
 * Threading this as props would mean every container component forwarding
 * things it does not use, and a satellite's tree is arbitrarily deep. Context
 * keeps the components honest: a component takes exactly the props the catalog
 * says it takes, plus whatever it asks this file for.
 */

export interface ActionRequest {
  readonly actionId: string;
  readonly payload: Record<string, unknown>;
  /**
   * The files this submission carries, if any.
   *
   * Kept beside the payload rather than inside it: a `File` has no JSON
   * representation, and putting one in the values map would make every
   * consumer of `payload` handle a type it cannot serialise. When this is
   * present the request goes out as multipart instead.
   */
  readonly files?: readonly (readonly [string, File])[] | undefined;
  /** When present, the hub asks before sending. See `ConfirmDialog`. */
  readonly confirm?: { readonly title: string; readonly body?: string | undefined } | undefined;
}

export interface RenderContextValue {
  /** The satellite whose screen this is — the default target for bare links. */
  readonly satelliteId: string;
  /** The screen being rendered, so paging can link back to it. */
  readonly screenId: string;
  /**
   * The query params this screen was fetched with.
   *
   * Passed down from the server rather than read from `location`, so paging
   * preserves a filter without the renderer having a second, drifting idea of
   * what the current request was.
   */
  readonly params: Readonly<Record<string, string>>;
  /** Satellites this principal may see; anything else renders as inert text. */
  readonly allowedSatelliteIds: readonly string[];
  /** From the last `validation` outcome, keyed by field name. */
  readonly fieldErrors: Readonly<Record<string, string>>;
  /** True while an action is in flight, so controls can refuse a double submit. */
  readonly busy: boolean;
  readonly dispatch: (request: ActionRequest) => void;
}

const RenderContext = createContext<RenderContextValue | undefined>(undefined);

export const RenderProvider = RenderContext.Provider;

export function useRender(): RenderContextValue {
  const value = useContext(RenderContext);
  if (value === undefined) {
    // A component rendered outside the provider would silently lose its links
    // and its ability to submit — a screen that looks right and does nothing.
    throw new Error("Renderer components must be rendered inside <ScreenRenderer>");
  }
  return value;
}

/**
 * The heading level a container's own title should use.
 *
 * A satellite composes sections without knowing how deeply the hub nested them,
 * so a fixed `<h2>` per component produces whatever heading order the tree
 * happens to have. Screen readers navigate by that order. Each container that
 * owns a title advances the level for its subtree instead.
 *
 * Level 1 belongs to the screen title in the page header, so containers start
 * at 2 and stop at 6, which is as far as HTML goes.
 */
const HeadingLevelContext = createContext(2);

export function useHeadingLevel(): 2 | 3 | 4 | 5 | 6 {
  const level = useContext(HeadingLevelContext);
  return Math.min(Math.max(level, 2), 6) as 2 | 3 | 4 | 5 | 6;
}

/**
 * Advances the level for a subtree — but only when the container actually
 * rendered a heading of its own.
 *
 * A `Page` with no title that still pushed its children down a level would make
 * the first real heading on the screen an `<h3>`, with nothing at `<h2>` above
 * it. Levels track headings that exist, not containers that might have had one.
 */
export function NestedHeadings({
  when = true,
  children,
}: {
  when?: boolean;
  children: React.ReactNode;
}) {
  const level = useContext(HeadingLevelContext);
  if (!when) return <>{children}</>;
  return (
    <HeadingLevelContext.Provider value={Math.min(level + 1, 6)}>
      {children}
    </HeadingLevelContext.Provider>
  );
}
