import { z } from "zod";
import { AudienceListSchema } from "./audience.js";

/**
 * What a satellite declares about itself. This is the durable asset: the
 * capability declaration from which screens, agent tools, outward MCP, and the
 * public API are all projected.
 */

const IdSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-z0-9]+(?:[.\-_][a-z0-9]+)*$/,
    "ids are lower-kebab/dot segments, e.g. \"orders.list\"",
  );

/** Reports the first duplicate `id` in a list, or undefined when all are unique. */
function firstDuplicateId(items: readonly { id: string }[]): string | undefined {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) return item.id;
    seen.add(item.id);
  }
  return undefined;
}

function rejectDuplicateIds(label: string) {
  return (items: readonly { id: string }[], ctx: z.RefinementCtx): void => {
    const duplicate = firstDuplicateId(items);
    if (duplicate !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate ${label} id "${duplicate}"`,
      });
    }
  };
}

export const ScreenParamSchema = z
  .object({
    name: z.string().min(1),
    required: z.boolean().default(false),
    description: z.string().optional(),
  })
  .strict();

export const ScreenDescriptorSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1),
    description: z.string().optional(),
    params: z.array(ScreenParamSchema).optional(),
    audience: AudienceListSchema,
  })
  .strict();

export const ActionDescriptorSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    audience: AudienceListSchema,
  })
  .strict();

export const NavEntrySchema = z
  .object({
    screenId: IdSchema,
    label: z.string().min(1),
    section: z.string().min(1).optional(),
    order: z.number().int().optional(),
  })
  .strict();

export const ManifestSchema = z
  .object({
    protocol: z.string().min(1),
    satelliteId: IdSchema,
    displayName: z.string().min(1),
    description: z.string().optional(),
    audience: AudienceListSchema,
    screens: z.array(ScreenDescriptorSchema).superRefine(rejectDuplicateIds("screen")),
    actions: z.array(ActionDescriptorSchema).superRefine(rejectDuplicateIds("action")),
    nav: z.array(NavEntrySchema).optional(),
    /** Present when the satellite serves MCP natively; absent means the hub generates a shim. */
    mcpUrl: z.string().url().optional(),
    healthPath: z.string().startsWith("/").optional(),
  })
  .strict();

export type Manifest = z.infer<typeof ManifestSchema>;
export type ScreenDescriptor = z.infer<typeof ScreenDescriptorSchema>;
export type ActionDescriptor = z.infer<typeof ActionDescriptorSchema>;
export type NavEntry = z.infer<typeof NavEntrySchema>;
