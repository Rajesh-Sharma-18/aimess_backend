import type { Request, Response } from "express";
import type { Redis, Cluster } from "ioredis";

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
import type { CommunityPinService } from "../../services/community-pin.service.js";

export class CommunityMessageController {
  constructor(
    private readonly service: CommunityMessageService,
    private readonly pinService: CommunityPinService,
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

    // Timestamp pagination (epoch ms). before_ts → newest-first; after_ts →
    // oldest-first; neither → newest page.
    const beforeTs =
      req.query.before_ts != null ? Number(req.query.before_ts) : undefined;
    const afterTs =
      req.query.after_ts != null ? Number(req.query.after_ts) : undefined;
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
        `conv:${result.roomId}`,
        JSON.stringify({
          event: "message:delete",
          // §2.3: self-describing tombstone — conversationId so a client can route
          // the delete even if the room isn't currently loaded.
          data: {
            messageId: result.id,
            conversationId: result.roomId,
            type: type === "forEveryone" ? "forEveryone" : "forMe",
            deletedBy: userId,
            sequenceNumber:
              (result as { sequenceNumber?: number }).sequenceNumber ?? 0,
          },
        })
      );
    }

    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
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
    const { messageId, communityId } = req.body as {
      messageId: string;
      communityId: string;
    };
    const result = await this.pinService.pin({
      roomId,
      messageId,
      userId,
      communityId,
    });
    await this.redis.publish(
      `community:${communityId}`,
      JSON.stringify({
        event: "community:message:pinned",
        data: {
          roomId,
          communityId,
          pin: result.pin,
          pinnedCount: result.pinnedCount,
        },
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
    const communityId = req.query.communityId as string;
    const result = await this.pinService.unpin({ roomId, messageId, userId });
    await this.redis.publish(
      `community:${communityId}`,
      JSON.stringify({
        event: "community:message:unpinned",
        data: {
          roomId,
          communityId,
          messageId,
          pinnedCount: result.pinnedCount,
        },
      })
    );
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_MESSAGE_UNPINNED", req.locale)));
  });

  getPins = asyncHandler(async (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const cursor = req.query.cursor as string | undefined;
    const limit = Number(req.query.limit) || 20;
    const pins = await this.pinService.list(roomId, { limit, cursor });
    const paginated = buildCursorResponse(
      pins as unknown as Record<string, unknown>[],
      limit,
      "pinnedAt"
    );
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(paginated, t("CHAT_PINS_FETCHED", req.locale)));
  });
}
