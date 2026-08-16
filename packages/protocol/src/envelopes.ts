import { z } from "zod";
import { UiNodeSchema } from "./node.js";
import { ProtocolVersionSchema } from "./version.js";

/**
 * The two response envelopes a satellite returns.
 *
 * `ActionResponse` is the piece that makes forms and workflows work with no
 * satellite JavaScript: the satellite replies with *what should now be true*
 * and the hub applies it. That is hypermedia thinking in a JSON envelope.
 */

export const ScreenResponseSchema = z
  .object({
    protocol: ProtocolVersionSchema,
    screen: z
      .object({
        id: z.string().min(1),
        title: z.string().min(1),
        breadcrumbs: z
          .array(
            z
              .object({
                label: z.string().min(1),
                // `.min(1)` like every other id on the wire: an empty screenId
                // is a crumb that looks navigable to a hub testing for
                // presence, but links nowhere.
                screenId: z.string().min(1).optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict(),
    ui: UiNodeSchema,
    meta: z
      .object({
        ttlSeconds: z.number().int().nonnegative().optional(),
        etag: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ToastSchema = z
  .object({
    level: z.enum(["success", "info", "warning", "error"]),
    message: z.string().min(1),
  })
  .strict();

export const PatchSchema = z
  .object({ targetId: z.string().min(1), ui: UiNodeSchema })
  .strict();

export const NavigateSchema = z
  .object({
    screenId: z.string().min(1),
    satelliteId: z.string().min(1).optional(),
    params: z.record(z.string()).optional(),
  })
  .strict();

const ActionOutcomeSchema = z.enum(["ok", "error", "validation"]);

/**
 * Outcome coherence rules exist so the hub never has to guess how to render a
 * response. A satellite that returns an incoherent combination gets a clear
 * failure at the proxy rather than a confusing screen.
 */
export const ActionResponseSchema = z
  .object({
    protocol: ProtocolVersionSchema,
    outcome: ActionOutcomeSchema,
    toast: ToastSchema.optional(),
    // The key is the field to attach the message to, so it has to name one.
    fieldErrors: z.record(z.string().min(1), z.string().min(1)).optional(),
    patch: z.array(PatchSchema).optional(),
    navigate: NavigateSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const isValidation = value.outcome === "validation";

    if (isValidation) {
      const count = Object.keys(value.fieldErrors ?? {}).length;
      if (count === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fieldErrors"],
          message:
            'outcome "validation" must carry at least one field error; ' +
            'use outcome "error" for a failure with no field to attach to',
        });
      }
    } else if (value.fieldErrors !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fieldErrors"],
        message: `fieldErrors is only meaningful with outcome "validation", not "${value.outcome}"`,
      });
    }

    if (value.outcome !== "ok" && value.patch !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["patch"],
        message: `a "${value.outcome}" outcome changed nothing, so it must not carry a patch`,
      });
    }
  });

export type ScreenResponse = z.infer<typeof ScreenResponseSchema>;
export type ActionResponse = z.infer<typeof ActionResponseSchema>;
export type ActionOutcome = z.infer<typeof ActionOutcomeSchema>;
export type Toast = z.infer<typeof ToastSchema>;
