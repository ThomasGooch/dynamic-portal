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
 * it was written, with the component named. The cost is a Zod parse per node on
 * a screen of a few dozen; the alternative is a stack trace three systems away.
 *
 * **Children are accepted everywhere and rendered where they mean something.**
 * The catalog does not say which components take children, so neither does
 * this. A `Divider` given children is not an error the hub reports, and
 * inventing one here would be the SDK asserting a rule the protocol does not
 * have.
 */

export type PropsOf<N extends ComponentName> = z.infer<(typeof COMPONENTS)[N]>;

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

    return {
      type: name,
      props: parsed.data as Record<string, unknown>,
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

/** Ties a value to the tool call that produced it. See PLAN.md on grounding. */
export function withSource(toolCallId: string, node: UiNode): UiNode {
  return { ...node, source: { toolCallId } };
}
