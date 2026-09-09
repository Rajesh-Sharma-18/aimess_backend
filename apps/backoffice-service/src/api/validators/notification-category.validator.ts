import { z } from "zod";

/**
 * Zod schemas for the Super Admin notification-category API.
 *
 * There is no create schema and no delete schema — the catalogue is fixed. The
 * id is a path parameter matched against the seeded catalogue by chat-service;
 * it is never accepted in a body, so it cannot be renamed or reused.
 */

/** Uppercase catalogue id ("FRIEND_REQUEST"). Shape only — existence is chat-service's call. */
export const notificationCategoryIdParamSchema = z.object({
  categoryId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Z][A-Z0-9_]*$/, "Category id must be uppercase snake case"),
});
export type NotificationCategoryIdParam = z.infer<
  typeof notificationCategoryIdParamSchema
>;

export const notificationPlatformEnum = z.enum(["ANDROID", "IOS", "WEB"]);

export const updateNotificationCategorySchema = z
  .object({
    // Ascending render order. Bounded so a typo cannot bury a category behind
    // an unreachable priority; duplicates are allowed and break on id.
    priority: z.number().int().min(1).max(999).optional(),
    // The platforms the chip is shown on. An EMPTY array is valid and means
    // "hidden everywhere" — which hides the chip, and never touches a single
    // stored notification.
    enabledPlatforms: z.array(notificationPlatformEnum).max(3).optional(),
  })
  .refine(
    (v) => v.priority !== undefined || v.enabledPlatforms !== undefined,
    {
      message: "At least one of priority or enabledPlatforms must be provided",
    }
  )
  .refine(
    (v) =>
      v.enabledPlatforms === undefined ||
      new Set(v.enabledPlatforms).size === v.enabledPlatforms.length,
    { message: "enabledPlatforms must not repeat a platform" }
  );
export type UpdateNotificationCategoryInput = z.infer<
  typeof updateNotificationCategorySchema
>;
