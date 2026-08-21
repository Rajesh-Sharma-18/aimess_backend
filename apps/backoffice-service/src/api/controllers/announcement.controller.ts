import { NotFoundError } from "@aimess/errors";
import { HTTP_STATUS, t } from "@aimess/constants";
import type { RequestHandler } from "express";
import { ApiResponse } from "@aimess/utils";

import { announcementService } from "../../services/index.js";
import { paginated } from "../lib/respond.js";
import type { ListAnnouncementsQuery } from "../../types/announcement.types.js";
import type {
  CreateAnnouncementInput,
  ListAnnouncementsQueryInput,
  UpdateAnnouncementInput,
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
      res
        .status(HTTP_STATUS.CREATED)
        .json(
          new ApiResponse(result, t("ADMIN_ANNOUNCEMENT_CREATED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};

/** PUT /v1/announcements/:announcementId — edit a still-SCHEDULED announcement. */
export const updateAnnouncement: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const announcementId = req.params.announcementId as string;
      const body = req.body as UpdateAnnouncementInput;
      const result = await announcementService.updateScheduledAnnouncement(
        announcementId,
        body,
        req.admin!.id
      );
      res.status(HTTP_STATUS.OK).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  })();
};

/** POST /v1/announcements/:announcementId/cancel */
export const cancelAnnouncement: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const announcementId = req.params.announcementId as string;
      const result = await announcementService.cancelAnnouncement(
        announcementId,
        req.admin!.id
      );
      res.status(HTTP_STATUS.OK).json({ success: true, data: result });
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
      res
        .status(HTTP_STATUS.OK)
        .json(
          paginated(
            result.data,
            result.pagination,
            t("ADMIN_ANNOUNCEMENTS_FETCHED", req.locale)
          )
        );
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
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            announcement,
            t("ADMIN_ANNOUNCEMENT_FETCHED", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};
