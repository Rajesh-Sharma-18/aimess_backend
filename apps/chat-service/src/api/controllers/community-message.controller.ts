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
import {
  normalizeMessageType,
  toWireMessage,
} from "../../lib/chat-message.serializer.js";
import type { CommunityMessageService } from "../../services/community-message.service.js";
import type { CommunityPinService } from "../../services/community-pin.service.js";
import type { ChatMessageOrchestrator } from "../../services/chat-message-orchestrator.js";

export class CommunityMessageController {
  constructor(
    private readonly service: CommunityMessageService,
    private readonly pinService: CommunityPinService,
    private readonly redis: Redis | Cluster,
    private readonly orchestrator: ChatMessageOrchestrator
  ) {}

  /**
   * POST /community/rooms/:roomId/messages — send a community message. Delegates
   * to the ChatMessageOrchestrator (send + community:message:new broadcast +
   * community-activity + community:updated bump). Active-membership and
   * suspended-room guards + idempotency live in the service. roomId (chat
   * GeneralRoom id) comes from the path; communityId (used for the broadcast) is
   * in the body. Returns the canonical wire message; 201 on a fresh insert, 200
   * on an idempotent replay (`idempotent: true`) — matching the private/group
   * send contract.
   */
  sendMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const body = req.body as {
      communityId: string;
      message: string;
      messageType: string;
      parentMessageId?: string | null;
      clientMessageId?: string | null;
      media?: { files: Array<Record<string, unknown>> };
      location?: Record<string, unknown>;
      contact?: Record<string, unknown>;
      sticker?: Record<string, unknown>;
    };

    // Flatten the structured body into the service attachments array, mirroring
    // the gRPC handler's priority: structured files > location > contact >
    // sticker. The orchestrator re-splits location/contact/sticker for the
    // broadcast shape via their `type` discriminator.
    let attachments: Array<Record<string, unknown>> | undefined;
    if (body.media?.files?.length) {
      attachments = body.media.files;
    } else if (body.location) {
      attachments = [{ type: "location", ...body.location }];
    } else if (body.contact) {
      attachments = [{ type: "contact", ...body.contact }];
    } else if (body.sticker) {
      attachments = [{ type: "sticker", ...body.sticker }];
    }

    const result = await this.orchestrator.sendCommunity({
      communityId: body.communityId,
      roomId,
      senderId: userId,
      message: body.message,
      messageType: body.messageType,
      parentMessageId: body.parentMessageId ?? null,
      clientMessageId: body.clientMessageId ?? null,
      attachments,
    });

    res
      .status(result.alreadySent ? HTTP_STATUS.OK : HTTP_STATUS.CREATED)
      .json(
        new ApiResponse(
          { ...result.message, idempotent: result.alreadySent },
          t("CHAT_MESSAGE_SENT", req.locale)
        )
      );
  });

  /**
   * POST /community/rooms/:roomId/read — mark this community room read.
   * Community read is COARSER than private/group: it advances the member's read
   * pointer to "now" (read-to-now) rather than to a specific message, and has NO
   * socket broadcast today — so this stays thin and calls bulkMarkRead directly
   * instead of routing through the orchestrator. The body's `upToMessageId` is
   * accepted (request parity) but not used for a per-message high-water mark.
   */
  markRead = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    await this.service.bulkMarkRead(userId, [roomId]);
    res.status(HTTP_STATUS.OK).json(new ApiResponse({ ok: true }));
  });

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
    const { content } = req.body as {
      communityId: string;
      content: { text: string };
    };
    const result = await this.service.editMessage({
      messageId,
      userId,
      content,
    });
    // Broadcast on the message's OWN room (GeneralRoom.id === communityId, so
    // result.roomId is the correct channel for all legitimate messages). Using
    // the body-supplied communityId here would let a member of community A fan
    // the event onto community B's channel (cross-channel info disclosure).
    await this.redis.publish(
      `community:${result.roomId}`,
      JSON.stringify({
        event: "community:message:edited",
        data: {
          messageId: result.id,
          communityId: result.roomId,
          roomId: result.roomId,
          senderId: result.sentBy,
          message: result.message ?? "",
          // §1: unified UPPER casing — single client-facing field `contentType`
          // in UPPER, matching community:message:new (not the raw lower value).
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
      .json(
        new ApiResponse(
          toWireMessage(result),
          t("CHAT_MESSAGE_EDITED", req.locale)
        )
      );
  });

  reactToMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const { emoji } = req.body as {
      communityId: string;
      emoji: string;
    };

    const result = await this.service.reactToMessage({
      messageId,
      userId,
      emoji,
    });

    this.redis
      .publish(
        `community:${result.roomId}`,
        JSON.stringify({
          event: "community:message:reaction",
          data: {
            messageId: result.messageId,
            communityId: result.roomId,
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

    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result ? toWireMessage(result) : result));
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
