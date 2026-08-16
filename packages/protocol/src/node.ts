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
 * owns all CSS; a satellite must not be able to smuggle markup or styles past a
 * caller that only ran protocol validation. This is duplicated in the catalog
 * on purpose — defence in depth at the layer that always runs.
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

export const UiNodeSchema: z.ZodType<UiNode> = z.lazy(() =>
  z
    .object({
      type: z.string().min(1),
      id: z.string().min(1).optional(),
      props: NodePropsSchema.optional(),
      children: z.array(UiNodeSchema).optional(),
      source: ProvenanceSchema.optional(),
    })
    .strict(),
);
