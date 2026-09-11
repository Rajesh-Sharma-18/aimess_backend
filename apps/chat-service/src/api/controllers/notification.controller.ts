import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import { buildPaginatedResponse } from "../../lib/pagination.js";
import {
  parseCategory,
  parsePlatform,
} from "../../lib/notification-category.js";
import type { NotificationService } from "../../services/notification.service.js";
import type { NotificationCatalogueService } from "../../services/notification-catalogue.service.js";

export class NotificationController {
  constructor(
    private readonly service: NotificationService,
    private readonly catalogue: NotificationCatalogueService
  ) {}

  /**
   * The server-driven notification-category catalogue for one platform.
   *
   * Shared by Android, iOS and Web: categories enabled for the requested
   * platform, sorted by the priority an administrator set, with the
   * `version` / `updatedAt` a client revalidates its offline cache against.
   * `ALL` is never returned — it is the client's own no-filter state and is
   * always rendered first.
   *
   * An unknown or missing `platform` is not an error: it falls back to WEB
   * rather than 400ing, because a client that cannot read the catalogue has no
   * chip row at all, and a typo in a query string is not worth that.
   */
  getCategories = asyncHandler(async (req: Request, res: Response) => {
    const platform = parsePlatform(req.query.platform) ?? "WEB";
    const catalogue = await this.catalogue.getCatalogue(platform);
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          { ...catalogue, platform },
          t("CHAT_NOTIFICATIONS_FETCHED", req.locale)
        )
      );
  });

  getNotifications = asyncHandler(async (req: Request, res: Response) => {
    const { userId, sessionId } = req.auth;
    const cursor = req.query.cursor as string | undefined;
    const limit = Number(req.query.limit) || 20;
    const page = Number(req.query.page) || 1;
    const category = parseCategory(req.query.type);
    // `counts` is UNREAD per tab (header badges); `totalForTab` is EVERY row in
    // the tab. They are not interchangeable: feeding the unread count into
    // pagination reported `totalData: 0` / `totalPage: 0` on any tab the user
    // had already read through, while the same response still returned rows and
    // `hasMore: true` — most visibly on Calls, where outgoing rows arrive read.
    const [notifications, counts, totalForTab] = await Promise.all([
      this.service.getNotifications(userId, {
        limit,
        cursor,
        category,
        viewerSessionId: sessionId,
      }),
      this.service.getCounts(userId, sessionId),
      this.service.getTotalCount(userId, category, sessionId),
    ]);
    const paginated = buildPaginatedResponse(
      notifications as unknown as Record<string, unknown>[],
      totalForTab,
      page,
      limit,
      "createdAt"
    );
    const msg = paginated.data.length
      ? t("CHAT_NOTIFICATIONS_FETCHED", req.locale)
      : t("CHAT_NO_NOTIFICATIONS_FOUND", req.locale);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse({ ...paginated, counts, type: category }, msg));
  });

  // Delta sync — everything that changed after `since` (epoch ms), tombstones
  // included. One call replaces a full-feed refetch on reconnect / cold start.
  syncNotifications = asyncHandler(async (req: Request, res: Response) => {
    const { userId, sessionId } = req.auth;
    const rawSince = req.query.since;
    const parsed = Number(rawSince);
    const since = new Date(Number.isFinite(parsed) && parsed > 0 ? parsed : 0);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    const [result, counts] = await Promise.all([
      this.service.syncSince(userId, {
        since,
        limit,
        viewerSessionId: sessionId,
      }),
      this.service.getCounts(userId, sessionId),
    ]);
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          { ...result, counts },
          t("CHAT_NOTIFICATIONS_FETCHED", req.locale)
        )
      );
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
      .json(
        new ApiResponse(result, t("CHAT_NOTIFICATIONS_MARKED_READ", req.locale))
      );
  });

  markAllRead = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    // Accept `type` / `before` from body OR querystring so existing callers
    // (no body) stay on the mark-everything path (backward compatible).
    const body = (req.body ?? {}) as { type?: unknown; before?: unknown };
    const rawType = body.type ?? req.query.type;
    const rawBefore = body.before ?? req.query.before;
    const category = parseCategory(rawType);
    let before: Date | null = null;
    if (typeof rawBefore === "number" && Number.isFinite(rawBefore)) {
      before = new Date(rawBefore);
    } else if (typeof rawBefore === "string" && rawBefore.trim()) {
      const asNum = Number(rawBefore);
      before = Number.isFinite(asNum) ? new Date(asNum) : new Date(rawBefore);
      if (Number.isNaN(before.getTime())) before = null;
    }
    const result = await this.service.markAllRead(userId, category, before);
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          { ...result, type: category },
          t("CHAT_NOTIFICATIONS_ALL_READ", req.locale)
        )
      );
  });

  recordAction = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const { id } = req.params as { id: string };
    const { action, body } = req.body as { action: string; body: string };
    await this.service.recordAction(id, userId, body, action);
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse({}, t("CHAT_NOTIFICATIONS_MARKED_READ", req.locale))
      );
  });

  // Soft-deletes ONE notification for the caller. Owner-scoped in the repo, so
  // an id the caller doesn't own mutates nothing; the response still reports
  // `deleted: false` with the caller's own unread count rather than 404, which
  // keeps a double-tap / retry idempotent instead of surfacing a false error.
  deleteNotification = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const { id } = req.params as { id: string };
    const result = await this.service.deleteNotification(id, userId);
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("CHAT_NOTIFICATION_DELETED", req.locale))
      );
  });

  getUnreadCount = asyncHandler(async (req: Request, res: Response) => {
    const { userId, sessionId } = req.auth;
    const unreadCount = await this.service.getUnreadCount(userId, sessionId);
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
