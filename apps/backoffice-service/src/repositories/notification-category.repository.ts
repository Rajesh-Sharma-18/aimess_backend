import { BadRequestError, NotFoundError } from "@aimess/errors";

import {
  chatClient,
  type AdminNotificationCategory,
} from "../grpc/chat.client.js";
import type {
  NotificationCategoryRow,
  NotificationPlatform,
  UpdateNotificationCategoriesInput,
  UpdateNotificationCategoryInput,
} from "../types/notification-category.types.js";

function toRow(row: AdminNotificationCategory): NotificationCategoryRow {
  return {
    id: row.id,
    priority: row.priority,
    defaultLabel: row.defaultLabel,
    iconKey: row.iconKey,
    enabledPlatforms: row.enabledPlatforms as NotificationPlatform[],
    updatedAt: row.updatedAt,
  };
}

/**
 * Notification categories are owned by chat-service (the service that owns the
 * Notification model they bucket) — this repository is a thin gRPC
 * pass-through, not a duplicate data store. Same shape as
 * `category.repository.ts`, which does the equivalent for community-service.
 */
export const notificationCategoryRepository = {
  async list(): Promise<NotificationCategoryRow[]> {
    const rows = await chatClient.adminListNotificationCategories();
    return rows.map(toRow);
  },

  async update(
    id: string,
    input: UpdateNotificationCategoryInput,
    actorId: string
  ): Promise<NotificationCategoryRow> {
    const res = await chatClient.adminUpdateNotificationCategory({
      categoryId: id,
      // Both halves of every optional field are sent explicitly. proto3 has no
      // field presence for scalars or repeated fields, so a request literal
      // that simply omits `priority` sends 0 — silently renumbering the
      // category instead of leaving it alone.
      priority: input.priority ?? 0,
      hasPriority: input.priority !== undefined,
      enabledPlatforms: input.enabledPlatforms ?? [],
      hasEnabledPlatforms: input.enabledPlatforms !== undefined,
      actorId,
    });
    if (!res.ok || !res.category) {
      // Two failures, two statuses: a priority chat-service refused is a 400
      // (the request was understood and rejected), anything else is an id
      // outside the seeded catalogue — a 404, never an implicit create.
      if (res.errorCode === "NOTIFICATION_CATEGORY_PRIORITY_INVALID") {
        throw new BadRequestError(res.errorCode);
      }
      throw new NotFoundError(res.errorCode || "NOTIFICATION_CATEGORY_NOT_FOUND");
    }
    return toRow(res.category);
  },

  /**
   * The grid's Save — every changed row in one atomic call. Returns the whole
   * catalogue as it now stands, not just the rows that moved.
   */
  async updateMany(
    updates: UpdateNotificationCategoriesInput["categories"],
    actorId: string
  ): Promise<NotificationCategoryRow[]> {
    const res = await chatClient.adminUpdateNotificationCategories({
      updates: updates.map((change) => ({
        categoryId: change.id,
        // Presence spelled out per row for the same reason as the single-row
        // call: proto3 sends 0 / [] for an omitted field, which would blank a
        // field the admin never touched.
        priority: change.priority ?? 0,
        hasPriority: change.priority !== undefined,
        enabledPlatforms: change.enabledPlatforms ?? [],
        hasEnabledPlatforms: change.enabledPlatforms !== undefined,
      })),
      actorId,
    });
    if (!res.ok) {
      // A priority chat-service refused — out of range, or a final state with
      // two rows on one number — is a 400: the request was understood and
      // rejected. Anything else is an id outside the seeded catalogue, a 404.
      if (
        res.errorCode === "NOTIFICATION_CATEGORY_PRIORITY_INVALID" ||
        res.errorCode === "NOTIFICATION_CATEGORY_PRIORITY_CONFLICT"
      ) {
        throw new BadRequestError(res.errorCode);
      }
      throw new NotFoundError(res.errorCode || "NOTIFICATION_CATEGORY_NOT_FOUND");
    }
    return res.categories.map(toRow);
  },
};
