import { AUDIT_ACTIONS } from "../constants/index.js";
import { notificationCategoryRepository } from "../repositories/notification-category.repository.js";
import type {
  NotificationCategoryRow,
  UpdateNotificationCategoriesInput,
  UpdateNotificationCategoryInput,
} from "../types/notification-category.types.js";
import { auditService } from "./audit.service.js";

/**
 * Super Admin notification-category configuration.
 *
 * `list` and `update` are the entire surface — deliberately. A category cannot
 * be created, deleted, renamed or given a new id from anywhere in the product,
 * so those operations have no service method to call.
 */
export const notificationCategoryService = {
  listCategories(): Promise<NotificationCategoryRow[]> {
    return notificationCategoryRepository.list();
  },

  async updateCategory(
    id: string,
    input: UpdateNotificationCategoryInput,
    actorId: string
  ): Promise<NotificationCategoryRow> {
    const category = await notificationCategoryRepository.update(
      id,
      input,
      actorId
    );

    await auditService.record({
      actorId,
      action: AUDIT_ACTIONS.NOTIFICATION_CATEGORY_UPDATED,
      targetType: "notification_category",
      targetId: category.id,
      after: {
        priority: category.priority,
        enabledPlatforms: category.enabledPlatforms,
      },
    });

    return category;
  },

  /**
   * The grid's Save: every row the administrator changed, applied atomically by
   * chat-service and audited one entry per row — same granularity as a
   * single-row edit, so the audit trail reads the same whichever path wrote it.
   *
   * Auditing happens AFTER the write returns, never alongside it: a rejected
   * draft (duplicate priority, unknown id) throws before this line and leaves
   * no audit entry for a change that did not happen.
   */
  async updateCategories(
    input: UpdateNotificationCategoriesInput,
    actorId: string
  ): Promise<NotificationCategoryRow[]> {
    const categories = await notificationCategoryRepository.updateMany(
      input.categories,
      actorId
    );

    const changed = new Set(input.categories.map((c) => c.id));
    await Promise.all(
      categories
        .filter((category) => changed.has(category.id))
        .map((category) =>
          auditService.record({
            actorId,
            action: AUDIT_ACTIONS.NOTIFICATION_CATEGORY_UPDATED,
            targetType: "notification_category",
            targetId: category.id,
            after: {
              priority: category.priority,
              enabledPlatforms: category.enabledPlatforms,
            },
          })
        )
    );

    return categories;
  },
};
