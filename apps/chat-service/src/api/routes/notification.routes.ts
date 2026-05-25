import { Router } from "express";

import { authenticate } from "../../middleware/authenticate.js";
import type { NotificationController } from "../controllers/notification.controller.js";

export function createNotificationRoutes(ctrl: NotificationController): Router {
  const router = Router();

  router.get("/", authenticate, ctrl.getNotifications);
  router.post("/read", authenticate, ctrl.markRead);
  router.post("/read-all", authenticate, ctrl.markAllRead);
  router.get("/unread-count", authenticate, ctrl.getUnreadCount);

  return router;
}
