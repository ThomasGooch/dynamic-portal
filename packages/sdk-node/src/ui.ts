import { COMPONENTS, COMPONENT_NAMES, type ComponentName } from "@portal/catalog";
import type { UiNode } from "@portal/protocol";
import type { z } from "zod";

/**
 * Building a screen, with the compiler doing the work the hub otherwise would.
 *
 * A satellite writing `{ type: "Text", props: { txt: "hello" } }` finds out
 * from the hub, at request time, in an environment it cannot see. Writing
 * `ui.Text({ txt: "hello" })` does not compile. That difference is most of what
 * the SDK is for, and it is why this exists alongside the conformance kit
 * rather than instead of it: the kit tells a team what is wrong, and this stops
 * it being wrong.
 *
 * **Every builder validates as it builds.** A prop the compiler cannot catch —
 * a `Link.href` that is not http(s), a `Table` whose columns are the wrong
 * shape at runtime because the data came from somewhere untyped — throws where
 * it was written, with the component named. The alternative is a stack trace
 * three systems away.
 *
 * The cost is a Zod parse per node, and an earlier version of this comment
 * described that as trivial "on a screen of a few dozen" nodes. That is false
 * for the component that matters: `Table.rows` is unbounded satellite *data*,
 * so a ten-thousand-row screen validates ten thousand records. The parse result
 * is discarded rather than returned, so at least nothing is cloned — see below
 * for why that is safe — but a satellite serving very large tables should build
 * its screen once and cache it rather than per request.
 *
 * **Children are accepted everywhere and rendered where they mean something.**
 * The catalog does not say which components take children, so neither does
 * this. A `Divider` given children is not an error the hub reports, and
 * inventing one here would be the SDK asserting a rule the protocol does not
 * have.
 */

/**
 * What a builder is *given*, which is the schema's input rather than its
 * output. Identical today because no component declares a default; the day one
 * does, `z.infer` would start demanding that the author supply the very prop
 * the default exists to supply.
 */
export type PropsOf<N extends ComponentName> = z.input<(typeof COMPONENTS)[N]>;

export class InvalidNodeError extends Error {
  constructor(
    readonly component: ComponentName,
    readonly issues: readonly { path: string; message: string }[],
  ) {
    super(
      `${component} was given props the catalog rejects: ` +
        issues.map((issue) => `${issue.path || "(root)"} ${issue.message}`).join("; "),
    );
    this.name = "InvalidNodeError";
  }
}

export type Builder<N extends ComponentName> = (
  props: PropsOf<N>,
  ...children: UiNode[]
) => UiNode;

function build<N extends ComponentName>(name: N): Builder<N> {
  return (props, ...children) => {
    const parsed = COMPONENTS[name].safeParse(props);
    if (!parsed.success) {
      // Thrown rather than returned. A satellite that carries on with a broken
      // node serves a screen the hub then refuses whole, and the refusal names
      // the screen rather than the line.
      throw new InvalidNodeError(
        name,
        parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    }

    // The caller's own object, not the parse output. Zod's `.parse` returns a
    // deep copy, which for a `Table` means cloning every row on every request
    // for no benefit — nothing here reads the parsed value. Safe only because
    // no catalog component declares a default; a test below holds that true.
    return {
      type: name,
      props: props as Record<string, unknown>,
      ...(children.length > 0 ? { children } : {}),
    };
  };
}

type Builders = { readonly [N in ComponentName]: Builder<N> };

/**
 * One builder per component, derived from the catalog rather than listed.
 *
 * A component added to the catalog appears here without anyone remembering to
 * add it — which is the same reason the MCP gateway's schema is generated and
 * not checked in. The type is the whole catalog, so it cannot drift.
 */
export const ui: Builders = Object.fromEntries(
  COMPONENT_NAMES.map((name) => [name, build(name)]),
) as Builders;

/**
 * Names a node so a `patch` can address it later.
 *
 * Separate from the props rather than smuggled into them: `id` belongs to the
 * protocol's node, not to any component's vocabulary, and a builder that
 * accepted it would have to strip it back out before validating.
 */
export function withId(id: string, node: UiNode): UiNode {
  return { ...node, id };
}

/**
 * Ties a value to the tool call that produced it. See PLAN.md on grounding.
 *
 * **A prop, unlike `id`.** The catalog declares `source` on each of the four
 * data-bearing components, grounding reads `props.source` when it decides
 * whether a number is cited, and every provenance mark the renderer draws
 * reads the same place. `UiNode` also carries a top-level `source` field, and
 * this function used to set that one — which nothing anywhere reads. A
 * satellite following the documented way to cite a tool call got a node with
 * no mark on screen and no credit from grounding.
 *
 * Its test asserted the field the function set rather than the field the
 * system reads, so it passed throughout. The test below now goes through the
 * catalog instead.
 */
export function withSource(toolCallId: string, node: UiNode): UiNode {
  // Only the data-bearing components declare `source`, and every component
  // schema is strict — so citing a `Text` produces a node the hub refuses.
  // Refusing here instead names the mistake where it was made, and lists the
  // components that can carry a citation at all.
  if (!CITABLE.has(node.type)) {
    throw new Error(
      `${node.type} cannot carry a source. Only ${[...CITABLE].sort().join(", ")} declare one, ` +
        "because only they display data a citation would refer to.",
    );
  }
  return { ...node, props: { ...node.props, source: { toolCallId } } };
}

/** The components whose schema declares `source`, read from the catalog. */
const CITABLE: ReadonlySet<string> = new Set(
  COMPONENT_NAMES.filter((name) => "source" in COMPONENTS[name].shape),
);
