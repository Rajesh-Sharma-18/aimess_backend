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

/**
 * The grid's Save — the administrator's whole draft in one body.
 *
 * Shape and per-row range are checked here; the catalogue-wide rule (no two
 * categories may END UP on the same priority) is checked in chat-service, which
 * is the only place that can see the rows the draft did NOT touch. Duplicate
 * ids and a duplicate priority WITHIN the draft are caught here because those
 * are decidable from the body alone, and catching them early spares a round
 * trip.
 */
export const updateNotificationCategoriesSchema = z.object({
  categories: z
    .array(
      z
        .object({
          id: z
            .string()
            .trim()
            .min(1)
            .max(64)
            .regex(/^[A-Z][A-Z0-9_]*$/, "Category id must be uppercase snake case"),
          priority: z
            .number()
            .int()
            .min(1)
            .max(NOTIFICATION_CATEGORY_COUNT)
            .optional(),
          enabledPlatforms: z.array(notificationPlatformEnum).max(3).optional(),
        })
        .refine(
          (v) => v.priority !== undefined || v.enabledPlatforms !== undefined,
          {
            message:
              "Each category must carry at least one of priority or enabledPlatforms",
          }
        )
        .refine(
          (v) =>
            v.enabledPlatforms === undefined ||
            new Set(v.enabledPlatforms).size === v.enabledPlatforms.length,
          { message: "enabledPlatforms must not repeat a platform" }
        )
    )
    // An empty draft is not a save — the panel hides Save until something is
    // dirty, and a request that changes nothing should not reach the database.
    .min(1)
    .max(NOTIFICATION_CATEGORY_COUNT),
})
  .refine(
    (v) => new Set(v.categories.map((c) => c.id)).size === v.categories.length,
    { message: "A category may appear at most once per request" }
  )
  .refine(
    (v) => {
      const priorities = v.categories
        .map((c) => c.priority)
        .filter((p): p is number => p !== undefined);
      return new Set(priorities).size === priorities.length;
    },
    { message: "Two categories in the same request cannot share a priority" }
  );
export type UpdateNotificationCategoriesInput = z.infer<
  typeof updateNotificationCategoriesSchema
>;
