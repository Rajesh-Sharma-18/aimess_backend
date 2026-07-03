import { NotFoundError } from "@aimess/errors";
import { HTTP_STATUS } from "@aimess/constants";
import type { RequestHandler } from "express";

import { announcementService } from "../../services/index.js";
import type { ListAnnouncementsQuery } from "../../types/announcement.types.js";
import type {
  CreateAnnouncementInput,
  ListAnnouncementsQueryInput,
} from "../validators/index.js";

/** POST /v1/announcements */
export const createAnnouncement: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const body = req.body as CreateAnnouncementInput;
      const result = await announcementService.createAnnouncement(
        body,
        req.admin!.id
      );
      res.status(HTTP_STATUS.CREATED).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  })();
};

/** GET /v1/announcements — paginated, filtered list. */
export const listAnnouncements: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const query = req.query as unknown as ListAnnouncementsQueryInput;
      const result = await announcementService.listAnnouncements(
        query as ListAnnouncementsQuery
      );
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  })();
};

/** GET /v1/announcements/:announcementId — full detail. */
export const getAnnouncementDetails: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const announcementId = req.params.announcementId as string;
      const announcement =
        await announcementService.getAnnouncementDetails(announcementId);
      if (!announcement) throw new NotFoundError("ANNOUNCEMENT_NOT_FOUND");
      res.status(HTTP_STATUS.OK).json({ success: true, data: announcement });
    } catch (error) {
      next(error);
    }
  })();
};
