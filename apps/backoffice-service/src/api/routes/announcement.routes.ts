import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import {
  createAnnouncement,
  getAnnouncementDetails,
  listAnnouncements,
} from "../controllers/index.js";
import {
  adminAuth,
  requirePermission,
  validateBody,
  validateParams,
  validateQuery,
} from "../middleware/index.js";
import {
  announcementIdParamSchema,
  createAnnouncementSchema,
  listAnnouncementsQuerySchema,
} from "../validators/index.js";

/** Announcements admin API — self-prefixed `/announcements`. */
export const announcementRoutes: IRouter = Router();

announcementRoutes.use(adminAuth);

announcementRoutes.get(
  "/announcements",
  requirePermission(PERMISSIONS.ANNOUNCEMENTS_READ),
  validateQuery(listAnnouncementsQuerySchema),
  listAnnouncements
);
announcementRoutes.post(
  "/announcements",
  requirePermission(PERMISSIONS.ANNOUNCEMENTS_MANAGE),
  validateBody(createAnnouncementSchema),
  createAnnouncement
);
announcementRoutes.get(
  "/announcements/:announcementId",
  requirePermission(PERMISSIONS.ANNOUNCEMENTS_READ),
  validateParams(announcementIdParamSchema),
  getAnnouncementDetails
);
