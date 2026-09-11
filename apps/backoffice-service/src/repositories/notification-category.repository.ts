import { BadRequestError, NotFoundError } from "@aimess/errors";

import {
  chatClient,
  type AdminNotificationCategory,
} from "../grpc/chat.client.js";
import type {
  NotificationCategoryRow,
  NotificationPlatform,
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
};
