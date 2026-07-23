import type { Request, Response } from "express";
import type { Redis, Cluster } from "ioredis";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import {
  buildPaginatedResponse,
  buildListResponse,
  buildCursorResponse,
  buildTimelineResponse,
  buildAroundResponse,
  parseTsCursor,
} from "../../lib/pagination.js";
import { publishConvUpdatedSafe } from "../../events/publish-conv-updated.js";
import { buildMessagePreview } from "../../events/publish-message-sent.js";
import { renderConvOverrides } from "../../lib/recipient-override-render.js";
import {
  buildChatMessageEvent,
  buildDeletePayload,
  groupStoredReactions,
} from "../../lib/chat-message.serializer.js";
import type { PrivateMessageService } from "../../services/private-message.service.js";
import type { PrivatePinService } from "../../services/private-pin.service.js";
import type { ChatMessageOrchestrator } from "../../services/chat-message-orchestrator.js";

export class PrivateMessageController {
  constructor(
    private readonly messageService: PrivateMessageService,
    private readonly pinService: PrivatePinService,
    private readonly redis: Redis | Cluster,
    private readonly orchestrator: ChatMessageOrchestrator
  ) {}

  /**
   * POST /private/rooms/:roomId/messages — send a private message. Delegates to
   * the ChatMessageOrchestrator (send + message:new broadcast + conv:updated bump
   * + FCM push). The friendship gate and idempotency live in the service. Returns
   * the canonical wire message; 201 on a fresh insert, 200 on an idempotent
   * replay (`idempotent: true`).
   */
  sendMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const body = req.body as {
      receiverId: string;
      content: {
        text: string;
        urls?: string[];
        files?: Array<Record<string, unknown>>;
        location?: Record<string, unknown>;
        contact?: Record<string, unknown>;
        sticker?: Record<string, unknown>;
      };
      messageType: string;
      parentMessageId?: string | null;
      clientMessageId?: string | null;
      clientTs?: number | null;
    };

    const result = await this.orchestrator.sendDirect({
      conversationType: "PRIVATE",
      roomId,
      senderId: userId,
      receiverId: body.receiverId,
      content: body.content,
      messageType: body.messageType,
      parentMessageId: body.parentMessageId ?? null,
      clientMessageId: body.clientMessageId ?? null,
      clientTs: body.clientTs ?? null,
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
   * POST /private/rooms/:roomId/read — mark this private conversation read up to
   * `upToMessageId`. Delegates to the ChatMessageOrchestrator (advance read
   * pointer + message:read receipt + read_sync to the reader's other devices),
   * mirroring the gRPC markMessagesRead effects. Returns { ok, readToSeq }.
   */
  markRead = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const { upToMessageId } = req.body as { upToMessageId: string };

    const { readToSeq } = await this.orchestrator.markReadDirect({
      conversationType: "PRIVATE",
      roomId,
      readerId: userId,
      upToMessageId,
    });

    res.status(HTTP_STATUS.OK).json(new ApiResponse({ ok: true, readToSeq }));
  });

  /**
   * `GET /private/rooms/:roomId/messages` (V1) — timestamp-named cursor params.
   * Frozen: V2 clients use {@link getMessagesV2}.
   */
  getMessages = asyncHandler((req: Request, res: Response) =>
    this.listMessages(req, res, "before_ts", "after_ts")
  );

  /**
   * `GET /api/v2/chat/private/rooms/:roomId/messages` — Cursor V2. Identical
   * handler, response and business logic to V1; the ONLY difference is that the
   * opaque compound `(createdAt, id)` keyset token arrives on
   * `before_cursor`/`after_cursor` instead of `before_ts`/`after_ts`, so V2
   * exposes no timestamp-shaped pagination params. Matches the community V2
   * contract (see `communityTimelineV2QuerySchema`).
   */
  getMessagesV2 = asyncHandler((req: Request, res: Response) =>
    this.listMessages(req, res, "before_cursor", "after_cursor")
  );

  /**
   * V2 — `GET /api/v2/chat/private/rooms/:roomId/changes` — the ZERO-LOSS changes feed.
   * Returns every message whose room CHANGE `revision > since_revision` (inserts AND
   * edits/deletes/reactions), current state, ordered revision ASC, plus `roomRevision`
   * (new high-water), `resetRequired` (deep-gap re-baseline) and `nextRevisionCursor`.
   * Mirrors the community `/changes` envelope exactly.
   */
  getChanges = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const sinceRevision = Number(req.query.since_revision) || 0;
    const limit = Number(req.query.limit) || 100;

    const result = await this.messageService.getChanges({
      roomId,
      userId,
      sinceRevision,
      limit,
    });

    res.status(HTTP_STATUS.OK).json(
      new ApiResponse(
        {
          roomRevision: result.roomRevision,
          resetRequired: result.resetRequired,
          hasMore: result.hasMore,
          nextRevisionCursor: result.nextRevisionCursor,
          data: result.items,
        },
        result.items.length
          ? t("CHAT_MESSAGES_FETCHED", req.locale)
          : t("CHAT_NO_MESSAGES_FOUND", req.locale)
      )
    );
  });

  /**
   * Shared timeline core for V1 + V2. `olderKey`/`newerKey` name the query params
   * that carry the opaque compound cursor — the single axis that differs between
   * the two versions. Everything else (access guard, seq keyset, around window,
   * enrichment, serialization, envelope) is version-agnostic.
   */
  private async listMessages(
    req: Request,
    res: Response,
    olderKey: "before_ts" | "before_cursor",
    newerKey: "after_ts" | "after_cursor"
  ) {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const limit = Number(req.query.limit) || 30;

    // V2 §3.2: prefer seq-based keyset cursors (gap-safe) when present.
    // before_seq → sequenceNumber < seq (newest-first);
    // after_seq  → sequenceNumber > seq (oldest-first);
    // around=<messageId> → window centered on a message (jump-to-message).
    const beforeSeq =
      req.query.before_seq != null ? Number(req.query.before_seq) : undefined;
    const afterSeq =
      req.query.after_seq != null ? Number(req.query.after_seq) : undefined;
    const around = req.query.around as string | undefined;

    if (around) {
      const { items, hasMoreOlder, hasMoreNewer, olderCursor, newerCursor } =
        await this.messageService.getMessagesAround({
          roomId,
          userId,
          messageId: around,
          limit,
        });
      const enriched = await this.messageService.enrichMessages(items, userId);
      const totalCount = await this.messageService.countMessages(roomId);
      const paginated = buildAroundResponse(enriched, totalCount, limit, {
        hasMoreOlder,
        hasMoreNewer,
        olderCursor,
        newerCursor,
      });
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            paginated,
            enriched.length
              ? t("CHAT_MESSAGES_FETCHED", req.locale)
              : t("CHAT_NO_MESSAGES_FOUND", req.locale)
          )
        );
      return;
    }

    if (beforeSeq != null || afterSeq != null) {
      const direction = afterSeq != null ? "after" : "before";
      const seq = afterSeq != null ? afterSeq : (beforeSeq as number);
      const [result, totalCount] = await Promise.all([
        this.messageService.getMessagesSeq({
          roomId,
          userId,
          direction,
          seq,
          limit,
        }),
        this.messageService.countMessages(roomId),
      ]);
      const enriched = await this.messageService.enrichMessages(
        result.items,
        userId
      );
      const paginated = buildTimelineResponse(
        enriched,
        totalCount,
        limit,
        result.hasMore,
        result.nextCursor
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            paginated,
            paginated.data.length
              ? t("CHAT_MESSAGES_FETCHED", req.locale)
              : t("CHAT_NO_MESSAGES_FOUND", req.locale)
          )
        );
      return;
    }

    // Compound `(createdAt, _id)` keyset pagination. The cursor is EITHER a plain
    // epoch-ms (first page / coarse jump) OR the opaque COMPOUND cursor
    // "<ms>_<id>" handed back as nextCursor. The _id tiebreaker keeps messages
    // that share a millisecond reachable instead of skipped at a page boundary.
    const beforeCursor = parseTsCursor(req.query[olderKey]);
    const afterCursor = parseTsCursor(req.query[newerKey]);
    const cursor = afterCursor ?? beforeCursor;
    const direction = afterCursor != null ? "after" : "before";

    const result = await this.messageService.getMessagesTimeline({
      roomId,
      userId,
      direction,
      ts: new Date(cursor ? cursor.ms : Date.now()),
      boundaryId: cursor?.id ?? null,
      // The first page (no cursor) includes the newest message; a cursor page is
      // exclusive so it never re-returns its own boundary row.
      inclusive: cursor == null,
      limit,
    });
    const enriched = await this.messageService.enrichMessages(
      result.items,
      userId
    );
    const paginated = buildTimelineResponse(
      enriched,
      result.total,
      limit,
      result.hasMore,
      result.nextCursor
    );
    const msg = paginated.data.length
      ? t("CHAT_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_MESSAGES_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  }

  getRoomMedia = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const type = req.query.type as string | undefined;
    const cursor = req.query.cursor as string | undefined;
    const limit = Number(req.query.limit) || 30;
    const messages = await this.messageService.listMedia({
      roomId,
      userId,
      type,
      cursor,
      limit,
    });
    const enriched = await this.messageService.enrichMessages(messages);
    const paginated = buildCursorResponse(enriched, limit, "createdAt");
    const msg = paginated.items.length
      ? t("CHAT_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_MESSAGES_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  deleteMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const type = req.query.type as string;

    const result =
      type === "forEveryone"
        ? await this.messageService.deleteForEveryone(messageId, userId)
        : await this.messageService.deleteForMe(messageId, userId);

    // §2.3: canonical tombstone — REST body == socket payload byte-for-byte.
    const tombstone = buildDeletePayload({
      conversationType: "PRIVATE",
      messageId: result.id,
      roomId: result.roomId,
      scope: type === "forEveryone" ? "forEveryone" : "forMe",
      deletedBy: userId,
      sequenceNumber: result.sequenceNumber,
    });
    if (result.roomId) {
      await this.redis.publish(
        `conv:${result.roomId}`,
        JSON.stringify({ event: "message:delete", data: tombstone })
      );
    }

    // For delete-for-everyone: recalculate and broadcast the new list preview
    // to all participants so the conversation list never shows "Message deleted".
    if (type === "forEveryone" && result.roomId) {
      void this.messageService
        .recalculateLastMessageAfterDelete(result.roomId, messageId)
        .then((recalc) => {
          if (recalc === null) return; // not the last message — no-op
          const preview = buildMessagePreview(
            recalc.messageType,
            recalc.content
          );
          // Private room participants come from the message itself.
          const participants = [
            (result as { senderId?: string }).senderId ?? userId,
            (result as { receiverId?: string }).receiverId ?? "",
          ].filter(Boolean);
          publishConvUpdatedSafe({
            redis: this.redis,
            type: "PRIVATE",
            roomId: result.roomId,
            recipientIds: participants,
            // Per-recipient correctness: the other participant, if they have
            // personally hidden the new shared previous-visible message, gets
            // THEIR own preview instead.
            resolveOverrides: (recipientIds) =>
              this.messageService
                .resolveForEveryoneOverrides(
                  result.roomId,
                  recalc.prevMessageId,
                  recipientIds
                )
                .then((raw) => renderConvOverrides(raw)),
            senderId: recalc.senderId,
            lastMessageId: recalc.prevMessageId ?? "",
            lastMessageAt: recalc.createdAt.getTime(),
            preview: { contentType: recalc.messageType, text: preview },
          });
        })
        .catch(() => {
          // Best-effort: a preview recalculation failure must never surface to
          // the user. The list will self-correct on next load.
        });
    }

    // For delete-for-me: send a targeted conv:updated ONLY to the deleting
    // user so their list shows the previous visible message instead of the
    // one they just hid. The shared room snapshot is NOT changed — the other
    // participant keeps seeing the original last message.
    if (type !== "forEveryone" && result.roomId) {
      void this.messageService
        .recalculateLastMessageAfterDeleteForMe(
          result.roomId,
          result.createdAt,
          userId
        )
        .then((recalc) => {
          // Skip unless the deleted message was the viewer's effective last
          // visible message — hiding an older message changes nothing in their list.
          if (recalc === null || !recalc.wasEffectiveLast) return;
          const preview = buildMessagePreview(
            recalc.messageType,
            recalc.content
          );
          publishConvUpdatedSafe({
            redis: this.redis,
            type: "PRIVATE",
            roomId: result.roomId,
            recipientIds: [userId],
            senderId: recalc.senderId,
            lastMessageId: recalc.prevMessageId ?? "",
            lastMessageAt: recalc.createdAt.getTime(),
            preview: { contentType: recalc.messageType, text: preview },
          });
        })
        .catch(() => {});
    }

    res.status(HTTP_STATUS.OK).json(new ApiResponse(tombstone));
  });

  getPins = asyncHandler(async (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const { userId } = req.auth;
    const cursor = req.query.cursor as string | undefined;
    const limit = Number(req.query.limit) || 20;
    const page = Number(req.query.page) || 1;
    const [pins, totalCount] = await Promise.all([
      this.pinService.list(roomId, userId, { limit, cursor }),
      this.pinService.countPins(roomId),
    ]);
    const paginated = buildPaginatedResponse(
      pins as unknown as Record<string, unknown>[],
      totalCount,
      page,
      limit,
      "pinnedAt"
    );
    const msg = paginated.data.length
      ? t("CHAT_PINS_FETCHED", req.locale)
      : t("CHAT_NO_PINS_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  // V2 §2.5: pin a message and broadcast pin:updated so the pinned banner
  // updates live for everyone in the room (multi-device consistent).
  pin = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const messageId = req.params.messageId as string;
    const result = await this.pinService.pin({ roomId, messageId, userId });
    const pinnedAt =
      result.pin.pinnedAt instanceof Date
        ? result.pin.pinnedAt.getTime()
        : Date.now();
    // Published to conv:<roomId> (where clients are joined) so it rides the
    // gateway's existing conv:* subscription, exactly like message:delete.
    await this.redis.publish(
      `conv:${roomId}`,
      JSON.stringify({
        event: "pin:updated",
        data: {
          roomId,
          conversationId: roomId,
          messageId,
          pinnedBy: userId,
          pinnedAt,
          action: "pinned",
          pinnedCount: result.pinnedCount,
        },
      })
    );
    res
      .status(HTTP_STATUS.CREATED)
      .json(new ApiResponse(result, "Message pinned"));
  });

  unpin = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const messageId = req.params.messageId as string;
    const result = await this.pinService.unpin({ roomId, messageId, userId });
    await this.redis.publish(
      `conv:${roomId}`,
      JSON.stringify({
        event: "pin:updated",
        data: {
          roomId,
          conversationId: roomId,
          messageId,
          unpinnedBy: userId,
          action: "unpinned",
          pinnedCount: result.pinnedCount,
        },
      })
    );
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, "Message unpinned"));
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
        .json(new ApiResponse(empty, t("CHAT_NO_MESSAGES_FOUND", req.locale)));
      return;
    }
    const skip = (page - 1) * limit;
    const [messages, totalCount] = await Promise.all([
      this.messageService.searchMessages({
        roomId,
        userId,
        query,
        limit,
        skip,
      }),
      this.messageService.countSearchResults(roomId, query, userId),
    ]);
    const enriched = await this.messageService.enrichMessages(messages);
    const paginated = buildListResponse(enriched, totalCount, page, limit);
    const msg = paginated.data.length
      ? t("CHAT_MESSAGES_SEARCHED", req.locale)
      : t("CHAT_NO_MESSAGES_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  forwardMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const { targetRoomId, receiverId, clientMessageId } = req.body as {
      targetRoomId: string;
      receiverId: string;
      clientMessageId?: string | null;
    };
    const result = await this.messageService.forwardMessage({
      sourceMessageId: messageId,
      // :roomId path param is the SOURCE room — bind the source message to it so
      // a caller can't forward (and thereby read) a message from a DM they're not in.
      sourceRoomId: req.params.roomId as string,
      targetRoomId,
      senderId: userId,
      receiverId,
      clientMessageId: clientMessageId ?? null,
    });
    // §1/§9: build canonical ChatMessage ONCE — REST body == socket payload.
    const full = result as unknown as Record<string, unknown>;
    const forwardedEvent = buildChatMessageEvent({
      id: result.id,
      clientMessageId: (full.clientMessageId as string) ?? "",
      roomId: targetRoomId,
      conversationType: "PRIVATE",
      senderId: userId,
      receiverId,
      messageType: result.messageType,
      content: result.content ?? null,
      reactions: [],
      isForwarded: true,
      serverTs: result.createdAt?.getTime() ?? Date.now(),
      sequenceNumber: (full.sequenceNumber as number) ?? 0,
    });
    await this.redis.publish(
      `conv:${targetRoomId}`,
      JSON.stringify({ event: "message:new", data: forwardedEvent })
    );
    // Fire-and-forget bump — must never delay the HTTP response.
    publishConvUpdatedSafe({
      redis: this.redis,
      type: "PRIVATE",
      roomId: targetRoomId,
      recipientIds: [userId, receiverId],
      senderId: userId,
      lastMessageId: result.id,
      lastMessageAt: result.createdAt?.getTime() ?? Date.now(),
      preview: {
        contentType: result.messageType,
        text: buildMessagePreview(result.messageType, result.content),
      },
    });
    res
      .status(HTTP_STATUS.CREATED)
      .json(
        new ApiResponse(forwardedEvent, t("CHAT_MESSAGE_FORWARDED", req.locale))
      );
  });

  getMessageReactions = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const roomId = req.params.roomId as string;
    const result = await this.messageService.getMessageReactions({
      messageId,
      roomId,
      requesterId: userId,
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  /**
   * POST /private/rooms/:roomId/messages/:messageId/reactions — add the caller's
   * `emoji` reaction. Delegates to the orchestrator (participant guard + idempotent
   * toggle-ON + message:reaction broadcast). Returns the updated ChatReactionGroup[]
   * under `{ reactions }`. Idempotent: re-adding an existing reaction is a no-op.
   */
  addReaction = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const messageId = req.params.messageId as string;
    const { emoji } = req.body as { emoji: string };
    const { reactions } = await this.orchestrator.reactDirect({
      conversationType: "PRIVATE",
      roomId,
      messageId,
      userId,
      emoji,
      op: "add",
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse({ reactions }));
  });

  /**
   * DELETE /private/rooms/:roomId/messages/:messageId/reactions/:emoji — remove the
   * caller's `emoji` reaction. Delegates to the orchestrator (participant guard +
   * idempotent toggle-OFF + message:reaction broadcast). Returns the updated
   * ChatReactionGroup[]. Idempotent: removing an absent reaction is a no-op.
   */
  removeReaction = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const messageId = req.params.messageId as string;
    const emoji = req.params.emoji as string;
    const { reactions } = await this.orchestrator.reactDirect({
      conversationType: "PRIVATE",
      roomId,
      messageId,
      userId,
      emoji,
      op: "remove",
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse({ reactions }));
  });

  editMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const { content } = req.body as {
      content: {
        text: string;
        urls?: string[];
        files?: Array<Record<string, unknown>>;
      };
    };
    const result = await this.messageService.editMessage({
      messageId,
      userId,
      content,
    });
    // §9: build canonical ChatMessage ONCE — REST body == socket payload.
    const full = result as unknown as Record<string, unknown>;
    const editedEvent = buildChatMessageEvent({
      id: result.id,
      clientMessageId: (full.clientMessageId as string) ?? "",
      roomId: result.roomId,
      conversationType: "PRIVATE",
      senderId: (full.senderId as string) ?? "",
      receiverId: (full.receiverId as string) ?? "",
      messageType: (full.messageType as string) ?? "TEXT",
      content: result.content ?? null,
      parentMessageId: (full.parentMessageId as string) || "",
      quoteData: full.quoteData ?? null,
      reactions: groupStoredReactions(full.reactions),
      isDeleted: Boolean(full.isDeleted),
      editedAt:
        result.editedAt instanceof Date
          ? result.editedAt.getTime()
          : Date.now(),
      clientTs: Number(
        (full.clientInfo as Record<string, unknown> | null)?.clientTs ?? 0
      ),
      serverTs:
        result.createdAt instanceof Date
          ? result.createdAt.getTime()
          : Date.now(),
      sequenceNumber: (full.sequenceNumber as number) ?? 0,
    });
    if (result.roomId) {
      await this.redis.publish(
        `conv:${result.roomId}`,
        JSON.stringify({ event: "message:edited", data: editedEvent })
      );
    }
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(editedEvent, t("CHAT_MESSAGE_EDITED", req.locale)));
  });

  reportMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const { reason, description } = req.body as {
      reason: string;
      description?: string;
    };
    const result = await this.messageService.reportMessage({
      messageId,
      reporterId: userId,
      reason,
      description,
    });
    res
      .status(HTTP_STATUS.CREATED)
      .json(new ApiResponse(result, t("CHAT_MESSAGE_REPORTED", req.locale)));
  });
}
