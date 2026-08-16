"use client";

import { isComponentName, propsSchemaFor } from "@portal/catalog";
import type { UiNode } from "@portal/protocol";
import { rendererFor } from "./registry";

/**
 * One node, validated and drawn.
 *
 * The props are parsed against the catalog schema *here*, immediately before a
 * component receives them, and that is what gives every component in this
 * renderer a real type instead of a cast. It is not the security boundary — the
 * proxy already rejected a screen the catalog does not accept, and rejecting at
 * the edge is what keeps a bad screen from reaching the browser at all. This is
 * the step that turns `Record<string, unknown>` into `PropsOf<"Table">`.
 *
 * Recursion into children happens here rather than inside the components, so
 * there is exactly one path into the tree and it always has this parse in front
 * of it. Depth is already bounded: the protocol rejects a tree deeper than
 * `MAX_NODE_DEPTH` on arrival, and `applyPatches` holds a spliced tree to the
 * same bound, so React never meets an unbounded nest here.
 */
export function Node({ node }: { node: UiNode }) {
  if (!isComponentName(node.type)) {
    return <Unrenderable type={node.type} reason="is not a component this portal knows" />;
  }

  const schema = propsSchemaFor(node.type);
  const parsed = schema?.safeParse(node.props ?? {});

  if (parsed === undefined || !parsed.success) {
    const detail = parsed?.error.issues[0];
    return (
      <Unrenderable
        type={node.type}
        reason={
          detail === undefined
            ? "has props this portal cannot accept"
            : `has an unacceptable prop: ${detail.path.join(".") || "(root)"} ${detail.message}`
        }
      />
    );
  }

  const Component = rendererFor(node.type);
  const children = (node.children ?? []).map((child, index) => (
    <Node key={child.id ?? `${child.type}-${index}`} node={child} />
  ));

  return <Component props={parsed.data} node={node} children={children} />;
}

/**
 * What a node the hub will not draw looks like.
 *
 * Visible rather than silent: a screen that is quietly missing a section is a
 * support ticket about missing data, while a screen with a labelled gap is a
 * bug report naming the component. It carries the component name and the
 * reason, and nothing the producer sent — the props are exactly what was found
 * unacceptable, so echoing them back into the DOM would defeat the check.
 */
function Unrenderable({ type, reason }: { type: string; reason: string }) {
  return (
    <div className="r-unrenderable" role="note">
      <strong>{type}</strong> {reason}.
    </div>
  );
}
