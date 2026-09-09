import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import { validateBody } from "../middleware/validate-body.js";
import {
  markReadSchema,
  markAllReadSchema,
  recordActionSchema,
} from "../validators/notification.validator.js";
import type { NotificationController } from "../controllers/notification.controller.js";

export function createNotificationRoutes(ctrl: NotificationController): Router {
  const router = Router();

  router.get("/", authenticate, ctrl.getNotifications);
  // Server-driven category catalogue (Android / iOS / Web share this one
  // response). Declared before the parameterised routes below so `categories`
  // is never read as a notification id.
  router.get("/categories", authenticate, ctrl.getCategories);
  router.get("/sync", authenticate, ctrl.syncNotifications);
  router.post(
    "/read",
    authenticate,
    validateBody(markReadSchema),
    ctrl.markRead
  );
  router.post(
    "/read-all",
    authenticate,
    validateBody(markAllReadSchema),
    ctrl.markAllRead
  );
  router.get("/unread-count", authenticate, ctrl.getUnreadCount);
  router.patch(
    "/:id/action",
    authenticate,
    validateBody(recordActionSchema),
    ctrl.recordAction
  );
  router.delete("/:id", authenticate, ctrl.deleteNotification);

  return router;
}
