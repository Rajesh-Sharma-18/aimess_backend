import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import { buildPaginatedResponse } from "../../lib/pagination.js";
import type { NotificationService } from "../../services/notification.service.js";

export class NotificationController {
  constructor(private readonly service: NotificationService) {}

  getNotifications = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const cursor = req.query.cursor as string | undefined;
    const limit = Number(req.query.limit) || 20;
    const page = Number(req.query.page) || 1;
    const [notifications, totalCount] = await Promise.all([
      this.service.getNotifications(userId, { limit, cursor }),
      this.service.countNotifications(userId),
    ]);
    const paginated = buildPaginatedResponse(
      notifications as unknown as Record<string, unknown>[],
      totalCount,
      page,
      limit,
      "createdAt"
    );
    const msg = paginated.data.length
      ? t("CHAT_NOTIFICATIONS_FETCHED", req.locale)
      : t("CHAT_NO_NOTIFICATIONS_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  // Accepts either a single notificationId or a notificationIds array
  // (validated by markReadSchema) so one endpoint covers mark-one and
  // mark-many. Scoped to the caller so a user can't mark another user's
  // notification read.
  markRead = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const body = req.body as
      | { notificationId: string }
      | { notificationIds: string[] };
    const ids =
      "notificationIds" in body ? body.notificationIds : [body.notificationId];
    const result = await this.service.markManyRead(ids, userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_NOTIFICATIONS_MARKED_READ", req.locale)));
  });

  markAllRead = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const result = await this.service.markAllRead(userId);
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("CHAT_NOTIFICATIONS_ALL_READ", req.locale))
      );
  });

  getUnreadCount = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const unreadCount = await this.service.getUnreadCount(userId);
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          { unreadCount },
          t("CHAT_UNREAD_COUNT_FETCHED", req.locale)
        )
      );
  });
}
