import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import {
  listNotificationCategories,
  updateNotificationCategory,
} from "../controllers/index.js";
import {
  adminAuth,
  requirePermission,
  validateBody,
  validateParams,
} from "../middleware/index.js";
import {
  notificationCategoryIdParamSchema,
  updateNotificationCategorySchema,
} from "../validators/index.js";

/**
 * Notification Category configuration — self-prefixed `/notification-categories`
 * so it resolves at `/v1/notification-categories/*`, matching the gateway path
 * convention (the gateway strips `/admin` and forwards `/v1/*` verbatim).
 *
 * TWO routes, and that is the whole module: read the catalogue, and change one
 * row's priority / platform enablement. There is no POST and no DELETE here,
 * and none downstream either — the categories are seeded, their ids are a
 * persisted client contract, and "no create, no delete" is enforced by the
 * absence of a route rather than by a check inside one.
 *
 * Both routes require `settings.manage`, which only SUPER_ADMIN holds (see
 * role-matrix.ts) — same gate as every other platform-wide configuration in
 * this service. READ is gated as tightly as WRITE on purpose: the grid IS the
 * configuration screen, so seeing it and changing it are one decision.
 */
export const notificationCategoryRoutes: IRouter = Router();

notificationCategoryRoutes.use(adminAuth);

notificationCategoryRoutes.get(
  "/notification-categories",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  listNotificationCategories
);

notificationCategoryRoutes.patch(
  "/notification-categories/:categoryId",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validateParams(notificationCategoryIdParamSchema),
  validateBody(updateNotificationCategorySchema),
  updateNotificationCategory
);
