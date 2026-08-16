import { z } from "zod";
import { COMPONENT_NAMES, propsSchemaFor } from "./components.js";

/**
 * The flat shape — what the agent emits.
 *
 * Deliberately a **list**, not a keyed map. Structured outputs require
 * `additionalProperties: false` on every object and do not accept
 * `additionalProperties`-as-schema, so a dictionary keyed by arbitrary element
 * ids cannot be strict-schema-constrained. A list can. That single constraint
 * is why the agent's shape differs from the renderer's, and why the adapters in
 * `adapters.ts` exist rather than everyone agreeing on one representation.
 *
 * It is also non-recursive, so validating a deep tree costs no stack. The
 * nested schema cannot say that; this one can, and a test holds it to 5000
 * levels.
 *
 * Structural integrity — every reference resolves, ids are unique, no cycles —
 * is checked here rather than left to the renderer, because a spec that passes
 * validation and then hangs or renders nothing is the worst of both.
 */

const ElementSchema = z
  .object({
    id: z.string(),
    type: z.enum(COMPONENT_NAMES as [string, ...string[]]),
    props: z.record(z.unknown()).optional(),
    children: z.array(z.string()).optional(),
  })
  .strict();

export const FlatSpecSchema = z
  .object({
    root: z.string(),
    elements: z.array(ElementSchema),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const byId = new Map<string, (typeof spec.elements)[number]>();

    for (const [index, element] of spec.elements.entries()) {
      if (byId.has(element.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["elements", index, "id"],
          message: `duplicate element id "${element.id}"`,
        });
        continue;
      }
      byId.set(element.id, element);

      // Props are validated against the component's own schema, so the flat
      // path enforces exactly what the nested path does.
      const schema = propsSchemaFor(element.type);
      const parsed = schema?.safeParse(element.props ?? {});
      if (parsed && !parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["elements", index, "props", ...issue.path],
            message: `${element.type}: ${issue.message}`,
          });
        }
      }
    }

    if (!byId.has(spec.root)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["root"],
        message: `root "${spec.root}" names no element`,
      });
      return;
    }

    for (const [index, element] of spec.elements.entries()) {
      for (const [childIndex, childId] of (element.children ?? []).entries()) {
        if (!byId.has(childId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["elements", index, "children", childIndex],
            message: `child "${childId}" names no element`,
          });
        }
      }
    }

    // Iterative cycle detection. A cyclic spec would otherwise be caught by the
    // renderer recursing forever, which is a hang rather than an error.
    const state = new Map<string, "open" | "done">();
    const stack: { id: string; phase: "enter" | "exit" }[] = [
      { id: spec.root, phase: "enter" },
    ];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.phase === "exit") {
        state.set(frame.id, "done");
        continue;
      }
      const seen = state.get(frame.id);
      if (seen === "done") continue;
      if (seen === "open") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["elements"],
          message: `cycle detected at element "${frame.id}"`,
        });
        return;
      }
      state.set(frame.id, "open");
      stack.push({ id: frame.id, phase: "exit" });
      for (const childId of byId.get(frame.id)?.children ?? []) {
        stack.push({ id: childId, phase: "enter" });
      }
    }
  });

export type FlatSpec = z.infer<typeof FlatSpecSchema>;
export type FlatElement = z.infer<typeof ElementSchema>;
