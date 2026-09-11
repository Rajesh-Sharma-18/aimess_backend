import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse } from "@aimess/utils";
import type { RequestHandler } from "express";

import { notificationCategoryService } from "../../services/index.js";
import type { UpdateNotificationCategoryInput } from "../validators/notification-category.validator.js";

/**
 * GET /v1/notification-categories — the whole fixed catalogue, every platform.
 *
 * Unpaginated on purpose: there are six rows and there will only ever be as
 * many as a migration seeds, so a page control would be furniture.
 */
export const listNotificationCategories: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const categories = await notificationCategoryService.listCategories();
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            categories,
            t("ADMIN_NOTIFICATION_CATEGORIES_FETCHED", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * PATCH /v1/notification-categories/:categoryId — priority and/or the
 * per-platform enable set. An id outside the seeded catalogue is a 404; it is
 * never created.
 */
export const updateNotificationCategory: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const categoryId = req.params.categoryId as string;
      const body = req.body as UpdateNotificationCategoryInput;
      const result = await notificationCategoryService.updateCategory(
        categoryId,
        body,
        req.admin!.id
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            result,
            t("ADMIN_NOTIFICATION_CATEGORY_UPDATED", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};
