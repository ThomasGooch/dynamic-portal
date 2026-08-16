import type { ReactNode } from "react";
import type { z } from "zod";
import type { COMPONENTS, ComponentName } from "@portal/catalog";
import type { UiNode } from "@portal/protocol";

/**
 * What a component in this renderer is.
 *
 * `props` is the catalog's inferred type, not `Record<string, unknown>`, and
 * that is the point: `Node` parses each node against the catalog schema before
 * choosing a component, so this type is what the parse produces rather than an
 * assertion about what arrived. A component cannot read a prop the catalog does
 * not define, because there is no such property on the type.
 *
 * `children` arrives already rendered. Components never recurse into the tree
 * themselves — `Node` does that and hands the results down — which keeps the
 * module graph one-directional and means no component can accidentally render a
 * child without the validation step in front of it.
 */

export type PropsOf<N extends ComponentName> = z.infer<(typeof COMPONENTS)[N]>;

export interface RendererArgs<N extends ComponentName> {
  readonly props: PropsOf<N>;
  readonly node: UiNode;
  readonly children: ReactNode[];
}

export type Renderer<N extends ComponentName> = (args: RendererArgs<N>) => ReactNode;
