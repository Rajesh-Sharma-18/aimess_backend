import { z } from "zod";

import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from "../../lib/notification-category.js";

/** The tab taxonomy as a zod enum — one source, so a new tab can't be missed. */
const categoryEnum = z.enum(
  NOTIFICATION_CATEGORIES as unknown as [
    NotificationCategory,
    ...NotificationCategory[],
  ]
);

export const getNotificationsSchema = z.object({
  cursor: z.string().nullish(),
  limit: z.coerce.number().min(1).max(100).default(20),
  type: categoryEnum.optional(),
});

export const recordActionSchema = z.object({
  action: z.enum(["TERMINATE", "CONFIRM", "REJECT", "ACCEPT"]),
  body: z.string().min(1).max(500),
});

export const markReadSchema = z.union([
  z.object({ notificationId: z.string().min(5).max(100) }),
  z.object({
    notificationIds: z.array(z.string().min(5).max(100)).min(1).max(500),
  }),
]);

/** POST /notifications/read-all — optional category + watermark (`before`). */
export const markAllReadSchema = z.preprocess(
  (v) => (v == null || typeof v !== "object" ? {} : v),
  z.object({
    // Derived from the tab taxonomy itself, never re-typed here. The hand-written
    // list silently missed CALLS when that tab was added, so "Mark all read" on
    // the Calls tab 400'd and the badge could not be cleared at all.
    type: categoryEnum.optional(),
    /**
     * Watermark (ISO-8601 or epoch-ms): only mark rows with `createdAt <= before`
     * as read. Notifications that arrive while the panel is open stay unread
     * (spec §9.2). Omit for the legacy mark-everything path.
     */
    before: z
      .union([z.string().min(1), z.number().int().nonnegative()])
      .optional(),
  })
);
