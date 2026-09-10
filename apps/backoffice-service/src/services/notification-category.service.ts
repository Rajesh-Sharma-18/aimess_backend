import { AUDIT_ACTIONS } from "../constants/index.js";
import { notificationCategoryRepository } from "../repositories/notification-category.repository.js";
import type {
  NotificationCategoryRow,
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
};
