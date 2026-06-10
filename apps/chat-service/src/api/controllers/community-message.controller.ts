import type { Request, Response } from "express";
import type { Redis, Cluster } from "ioredis";

import { logger } from "@aimess/logger";
import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import {
  buildPaginatedResponse,
  buildListResponse,
  buildCursorResponse,
  buildTimelineResponse,
} from "../../lib/pagination.js";
import { normalizeMessageType } from "../../lib/chat-message.serializer.js";
import type { CommunityMessageService } from "../../services/community-message.service.js";

export class CommunityMessageController {
  constructor(
    private readonly service: CommunityMessageService,
    private readonly redis: Redis | Cluster
  ) {}

  getMessages = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const limit = Number(req.query.limit) || 30;
    const around = req.query.around as string | undefined;

    if (around) {
      const { items } = await this.service.getMessagesAround({
        roomId,
        userId,
        messageId: around,
        limit,
      });
      const totalCount = await this.service.countMessages(roomId);
      const paginated = buildTimelineResponse(
        items as unknown as Record<string, unknown>[],
        totalCount,
        limit,
        false,
        null
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            paginated,
            items.length
              ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
              : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale)
          )
        );
      return;
    }

    const beforeTs =
      req.query.before_ts != null ? Number(req.query.before_ts) : undefined;
    const afterTs =
      req.query.after_ts != null ? Number(req.query.after_ts) : undefined;

    // Incremental-sync mode: after_ts only.
    // Returns every message (new, edited, reacted, deleted tombstone) whose
    // updatedAt >= after_ts. Feed the returned nextCursor as the next after_ts.
    if (afterTs != null) {
      const result = await this.service.getMessagesSince({
        roomId,
        userId,
        fromTs: new Date(afterTs),
        limit,
      });
      const msg = result.items.length
        ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
        : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale);
      res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
          {
            data: result.items,
            hasMore: result.hasMore,
            // Store this as the next after_ts to page forward or re-sync.
            nextCursor: result.nextCursor,
          },
          msg
        )
      );
      return;
    }

    // Scroll / history mode: before_ts → newest-first, omit → latest page.
    const direction = afterTs != null ? "after" : "before";
    const tsMs =
      afterTs != null ? afterTs : beforeTs != null ? beforeTs : Date.now();

    const [result, totalCount] = await Promise.all([
      this.service.getMessagesTimeline({
        roomId,
        userId,
        direction,
        ts: new Date(tsMs),
        limit,
      }),
      this.service.countMessages(roomId),
    ]);
    const paginated = buildTimelineResponse(
      result.items as unknown as Record<string, unknown>[],
      totalCount,
      limit,
      result.hasMore,
      result.nextCursor
    );
    const msg = paginated.data.length
      ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  getConversation = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const pageNumber = Number(req.query.pageNumber) || 1;
    const limit = Number(req.query.limit) || 30;
    const timestamp = req.query.timestamp
      ? Number(req.query.timestamp)
      : undefined;
    const { messages, total } = await this.service.getConversation({
      roomId,
      userId,
      pageNumber,
      limit,
      timestamp,
    });
    const paginated = buildPaginatedResponse(
      messages as unknown as Record<string, unknown>[],
      total,
      pageNumber,
      limit,
      "createdAt"
    );
    const msg = paginated.data.length
      ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  getRoomMedia = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const type = req.query.type as string | undefined;
    const cursor = req.query.cursor as string | undefined;
    const limit = Number(req.query.limit) || 30;
    const messages = await this.service.listMedia({
      roomId,
      userId,
      type,
      cursor,
      limit,
    });
    const paginated = buildCursorResponse(
      messages as unknown as Record<string, unknown>[],
      limit,
      "createdAt"
    );
    const msg = paginated.items.length
      ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  editMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const { communityId, content } = req.body as {
      communityId: string;
      content: { text: string };
    };
    const result = await this.service.editMessage({
      messageId,
      userId,
      content,
    });
    // Broadcast on the /community channel: clients join community:<communityId>
    // rooms and the gateway only psubscribes "community:*", so the edit must
    // mirror the send path (community:<communityId> / community:message:new).
    await this.redis.publish(
      `community:${communityId}`,
      JSON.stringify({
        event: "community:message:edited",
        data: {
          messageId: result.id,
          communityId,
          roomId: result.roomId,
          senderId: result.sentBy,
          message: result.message ?? "",
          // §1: unified UPPER casing — match community:message:new (which emits
          // both messageType and contentType in UPPER), not the raw lower value.
          messageType: normalizeMessageType(result.messageType),
          contentType: normalizeMessageType(result.messageType),
          editedAt:
            result.editedAt instanceof Date
              ? result.editedAt.getTime()
              : Date.now(),
        },
      })
    );
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_MESSAGE_EDITED", req.locale)));
  });

  reactToMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const { communityId, emoji } = req.body as {
      communityId: string;
      emoji: string;
    };

    const result = await this.service.reactToMessage({
      messageId,
      userId,
      communityId,
      emoji,
    });

    this.redis
      .publish(
        `community:${communityId}`,
        JSON.stringify({
          event: "community:message:reaction",
          data: {
            messageId: result.messageId,
            communityId: result.communityId,
            reactions: result.reactions,
          },
        })
      )
      .catch((err: unknown) => {
        logger.warn(
          `community:message:reaction publish failed: ${String(err)}`
        );
      });

    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_MESSAGE_EDITED", req.locale))); // TODO: add CHAT_MESSAGE_REACTED key to @aimess/constants
  });

  deleteMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const type = req.query.type as string;

    const result =
      type === "forEveryone"
        ? await this.service.deleteForAll(messageId, userId)
        : await this.service.deleteForMe(messageId, userId);

    // Emit real-time deletion event to the community room.
    // Client rule: hide for everyone on "forEveryone"; hide only if deletedBy===myId on "forMe".
    if (result?.roomId) {
      await this.redis.publish(
        `community:${result.roomId}`,
        JSON.stringify({
          event: "community:message:deleted",
          data: {
            messageId: result.id,
            communityId: result.roomId,
            roomId: result.roomId,
            deleteType: type === "forEveryone" ? "forEveryone" : "forMe",
            deletedBy: userId,
          },
        })
      );
    }

    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  /**
   * GET /rooms/:roomId/sync?since_ts=<ms>&limit=<n>
   *
   * Community incremental-sync REST endpoint. Returns all messages (new,
   * edited, reacted, deleted tombstones) whose `updatedAt >= since_ts`,
   * sorted oldest-first. Mirrors `GET /rooms/:roomId/messages?after_ts=` but
   * is rate-limited independently and uses a mandatory `since_ts` parameter so
   * the intent is unambiguous.
   *
   * Response shape: `{ data, hasMore, nextCursor }` — `nextCursor` is the
   * epoch-ms string of the last item's updatedAt; feed it back as `since_ts`.
   */
  syncMessages = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const sinceTs = Number(req.query.since_ts);
    const limit = Number(req.query.limit) || 50;

    const result = await this.service.getMessagesSince({
      roomId,
      userId,
      fromTs: new Date(sinceTs),
      limit,
    });

    const msg = result.items.length
      ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale);

    res.status(HTTP_STATUS.OK).json(
      new ApiResponse(
        {
          data: result.items,
          hasMore: result.hasMore,
          nextCursor: result.nextCursor,
        },
        msg
      )
    );
  });

  searchMessages = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const query = ((req.query.q as string) ?? "").trim();
    const limit = Number(req.query.limit) || 30;
    const page = Number(req.query.page) || 1;
    if (!query) {
      const empty = buildListResponse([], 0, page, limit);
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            empty,
            t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale)
          )
        );
      return;
    }
    const [messages, totalCount] = await Promise.all([
      this.service.searchMessages({ roomId, userId, query, limit }),
      this.service.countSearchResults(roomId, query),
    ]);
    const paginated = buildListResponse(messages, totalCount, page, limit);
    const msg = paginated.data.length
      ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  pinMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const messageId = req.params.messageId as string;
    const communityId = roomId; // roomId === communityId invariant for community rooms

    const result = await this.service.pinMessage({
      messageId,
      userId,
      roomId,
      communityId,
    });
    await this.redis.publish(
      `community:${communityId}`,
      JSON.stringify({
        event: "community:message:pinned",
        data: { messageId, communityId, roomId, ...result, pinnedBy: userId },
      })
    );
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_MESSAGE_PINNED", req.locale)));
  });

  unpinMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const messageId = req.params.messageId as string;
    const communityId = roomId;

    const result = await this.service.unpinMessage({
      messageId,
      userId,
      roomId,
      communityId,
    });
    await this.redis.publish(
      `community:${communityId}`,
      JSON.stringify({
        event: "community:message:unpinned",
        data: { messageId, communityId, roomId, ...result, unpinnedBy: userId },
      })
    );
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_MESSAGE_UNPINNED", req.locale)));
  });
}
