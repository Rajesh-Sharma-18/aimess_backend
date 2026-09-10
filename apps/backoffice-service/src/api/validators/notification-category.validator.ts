import { z } from "zod";

import { NOTIFICATION_CATEGORY_COUNT } from "../../types/notification-category.types.js";

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
    // Ascending render order: a whole number in 1..N, N being the size of the
    // fixed catalogue. Anything else — 0, a negative, 1.5, "abc", null, a
    // slot past the last category — is rejected here and again in chat-service,
    // which owns the rows. A priority another category already holds IS
    // accepted: it is a reorder, and chat-service renumbers the catalogue in
    // one transaction so the stored order stays unique and gap-free.
    priority: z
      .number()
      .int()
      .min(1)
      .max(NOTIFICATION_CATEGORY_COUNT)
      .optional(),
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
