import { z } from "zod";

/**
 * A UI node as the *protocol* understands it.
 *
 * The protocol deliberately does not know the component catalog. It validates
 * that a node is structurally a node — a `type` discriminant, optional props,
 * optional children — and leaves "is this a legal component with legal props"
 * to `@portal/catalog`.
 *
 * That separation is load-bearing: the catalog evolves on a faster clock than
 * the protocol, and coupling them would mean a coordinated release every time
 * a component is added.
 *
 * The one thing the protocol *does* enforce is the styling boundary. The hub
 * owns all CSS; a satellite must not be able to name a presentation prop on a
 * node and have it reach the DOM. This is duplicated in the catalog on purpose
 * — defence in depth at the layer that always runs.
 *
 * The scan is deliberately shallow: it covers the prop names a component
 * receives, not values nested inside them. Nested values are satellite *data*
 * (a table row may legitimately have a column called `class`), so the catalog,
 * which knows which props are spread onto elements, owns that half.
 */

/** Prop names that would hand a satellite control of presentation or markup. */
export const FORBIDDEN_PROP_KEYS = Object.freeze([
  "className",
  "class",
  "style",
  "css",
  "sx",
  "dangerouslySetInnerHTML",
  "innerHTML",
  "outerHTML",
] as const);

const forbidden = new Set<string>(FORBIDDEN_PROP_KEYS);

export const NodePropsSchema = z
  .record(z.unknown())
  .superRefine((props, ctx) => {
    for (const key of Object.keys(props)) {
      if (forbidden.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message:
            `Prop "${key}" is not permitted: the hub owns all presentation. ` +
            `Express intent with semantic props (variant, tone, size) instead.`,
        });
      }
    }
  });

/** Links a rendered value back to the tool call that produced it (see grounding). */
export const ProvenanceSchema = z
  .object({ toolCallId: z.string().min(1) })
  .strict();

// Optional members are spelled `?: T | undefined` because the workspace enables
// `exactOptionalPropertyTypes`, while Zod infers optionals as `T | undefined`.
// Matching Zod here keeps the strict compiler setting for everyone else.
export interface UiNode {
  type: string;
  id?: string | undefined;
  props?: Record<string, unknown> | undefined;
  children?: UiNode[] | undefined;
  source?: { toolCallId: string } | undefined;
}

/**
 * How deep a node tree may nest.
 *
 * Zod validates a recursive schema with recursive calls, so an unbounded tree
 * from a satellite overflows the V8 stack with a `RangeError` — not a
 * `ZodError` — around 1.5k levels. A hub that only catches `ZodError` would
 * turn a malformed response into a 500, or crash the request handler outright.
 * The bound is checked iteratively *before* parsing so the check itself cannot
 * be the thing that overflows. 64 is far past any real screen.
 */
export const MAX_NODE_DEPTH = 64;

const UiNodeTreeSchema: z.ZodType<UiNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z
    .object({
      type: z.string().min(1),
      id: z.string().min(1).optional(),
      props: NodePropsSchema.optional(),
      children: z.array(UiNodeTreeSchema).optional(),
      source: ProvenanceSchema.optional(),
    })
    .strict(),
);

/**
 * One iterative walk of an untrusted tree, before Zod recurses into it.
 * Returns the first problem found, or undefined.
 *
 * It also reports a repeated `id`: ids are what `patch.targetId` addresses, so
 * two nodes sharing one makes a patch ambiguous — the hub cannot know which
 * subtree the satellite meant to replace.
 */
function inspectTree(root: unknown): string | undefined {
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 1 }];
  const seenIds = new Set<string>();

  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    const { node, depth } = entry;

    if (depth > MAX_NODE_DEPTH) return `node tree nests deeper than ${MAX_NODE_DEPTH} levels`;
    if (typeof node !== "object" || node === null) continue;

    const { id, children } = node as { id?: unknown; children?: unknown };
    if (typeof id === "string" && id !== "") {
      if (seenIds.has(id)) return `duplicate node id "${id}"`;
      seenIds.add(id);
    }
    if (!Array.isArray(children)) continue;
    for (const child of children) stack.push({ node: child, depth: depth + 1 });
  }

  return undefined;
}

export const UiNodeSchema: z.ZodType<UiNode, z.ZodTypeDef, unknown> = z
  .unknown()
  .superRefine((value, ctx) => {
    const problem = inspectTree(value);
    if (problem !== undefined) {
      // Fatal so the pipeline stops here: the whole point is not to hand an
      // over-deep tree to the recursive parser.
      ctx.addIssue({ code: z.ZodIssueCode.custom, fatal: true, message: problem });
    }
  })
  .pipe(UiNodeTreeSchema);
