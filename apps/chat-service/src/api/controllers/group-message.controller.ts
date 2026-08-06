import type { Request, Response } from "express";
import type { Redis, Cluster } from "ioredis";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";
import { V2_TIMELINE_LIMIT } from "../validators/query.validator.js";
import { NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import {
  buildPaginatedResponse,
  buildCursorResponse,
  buildTimelineResponse,
  buildAroundResponse,
  buildTimelinePageV2,
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
import type { GroupMessageService } from "../../services/group-message.service.js";
import type { GroupPinService } from "../../services/group-pin.service.js";
import type { ChatMessageOrchestrator } from "../../services/chat-message-orchestrator.js";

export class GroupMessageController {
  constructor(
    private readonly messageService: GroupMessageService,
    private readonly pinService: GroupPinService,
    private readonly redis: Redis | Cluster,
    private readonly orchestrator: ChatMessageOrchestrator
  ) {}

  /**
   * POST /groups/:roomId/messages — send a group message. Delegates to the
   * ChatMessageOrchestrator (send + message:new broadcast + conv:updated bump +
   * FCM push fan-out to active members). Active-membership and idempotency live
   * in the service. Returns the canonical wire message; 201 on a fresh insert,
   * 200 on an idempotent replay (`idempotent: true`).
   */
  sendMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const body = req.body as {
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
      conversationType: "GROUP",
      roomId,
      senderId: userId,
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
   * POST /groups/:roomId/read — mark this group read up to `upToMessageId`.
   * Delegates to the ChatMessageOrchestrator (advance the group-member read
   * pointer + message:read receipt + read_sync to the reader's other devices),
   * mirroring the gRPC markMessagesRead effects. Returns { ok, readToSeq }.
   */
  markRead = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const { upToMessageId } = req.body as { upToMessageId: string };

    const { readToSeq } = await this.orchestrator.markReadDirect({
      conversationType: "GROUP",
      roomId,
      readerId: userId,
      upToMessageId,
    });

    res.status(HTTP_STATUS.OK).json(new ApiResponse({ ok: true, readToSeq }));
  });

  /**
   * `GET /api/chat/group/rooms/:roomId/messages` — V1 timestamp cursor.
   * Frozen: V2 clients use {@link getMessagesV2}.
   */
  getMessages = asyncHandler((req: Request, res: Response) =>
    this.listMessages(req, res, "before_ts", "after_ts")
  );

  /**
   * `GET /api/v2/chat/group/rooms/:roomId/messages` — Cursor V2. Identical
   * handler, response and business logic to V1; the ONLY difference is that the
   * opaque compound `(createdAt, id)` keyset token arrives on
   * `before_cursor`/`after_cursor`, so V2 exposes no timestamp-shaped params.
   * Mirrors the private V2 contract exactly (see `PrivateMessageController`).
   */
  getMessagesV2 = asyncHandler((req: Request, res: Response) =>
    this.listMessagesV2(req, res)
  );

  /**
   * V2 timeline — `before_seq`/`after_seq`/`around` only. Byte-identical contract
   * to PrivateMessageController.listMessagesV2; the two must not drift.
   */
  private async listMessagesV2(req: Request, res: Response) {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const limit = Number(req.query.limit) || V2_TIMELINE_LIMIT;
    const around = req.query.around as string | undefined;

    const send = (payload: { items: unknown[] } & Record<string, unknown>) =>
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            payload,
            payload.items.length
              ? t("CHAT_MESSAGES_FETCHED", req.locale)
              : t("CHAT_NO_MESSAGES_FOUND", req.locale)
          )
        );

    if (around) {
      const { items, hasMoreOlder, hasMoreNewer, olderCursor, newerCursor } =
        await this.messageService.getMessagesAround({
          roomId,
          userId,
          messageId: around,
          limit,
        });
      const [wire, pinnedMessage] = await Promise.all([
        this.messageService.enrichForWire(items, userId),
        this.pinService.getActivePinSummary(roomId, userId),
      ]);
      send({
        ...buildTimelinePageV2(wire, limit, {
          hasMoreOlder,
          hasMoreNewer,
          olderCursor,
          newerCursor,
        }),
        pinnedMessage,
      });
      return;
    }

    const beforeSeq =
      req.query.before_seq != null ? Number(req.query.before_seq) : undefined;
    const afterSeq =
      req.query.after_seq != null ? Number(req.query.after_seq) : undefined;

    const result = await this.messageService.getMessagesSeq({
      roomId,
      userId,
      direction: afterSeq != null ? "after" : "before",
      seq: afterSeq ?? beforeSeq ?? null,
      limit,
    });
    const [wire, pinnedMessage] = await Promise.all([
      this.messageService.enrichForWire(result.items, userId),
      this.pinService.getActivePinSummary(roomId, userId),
    ]);
    send({
      ...buildTimelinePageV2(wire, limit, result.cursors),
      roomRevision: result.roomRevision,
      pinnedMessage,
    });
  }

  /**
   * V2 — `GET /api/v2/chat/group/rooms/:roomId/changes` — the ZERO-LOSS changes feed.
   * Identical envelope to the private and community equivalents.
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
          items: result.items,
          roomRevision: result.roomRevision,
          resetRequired: result.resetRequired,
          hasMore: result.hasMore,
          nextRevisionCursor: result.nextRevisionCursor,
        },
        result.items.length
          ? t("CHAT_MESSAGES_FETCHED", req.locale)
          : t("CHAT_NO_MESSAGES_FOUND", req.locale)
      )
    );
  });

  /**
   * Shared timeline core for V1 + V2. `olderKey`/`newerKey` name the query params
   * carrying the opaque compound cursor — the single axis that differs between the
   * two versions. Everything else is version-agnostic.
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
    const beforeSeq =
      req.query.before_seq != null ? Number(req.query.before_seq) : undefined;
    const afterSeq =
      req.query.after_seq != null ? Number(req.query.after_seq) : undefined;
    const around = req.query.around as string | undefined;

    // Every other active member's read cursor — included on every page so the
    // FE can hydrate per-message "seen by" state WITHOUT waiting for a live
    // `message:read` event (see GroupMessageService.getMemberReadCursors).
    // Best-effort: never blocks/fails the message page itself.
    const memberReadSeq = await this.messageService
      .getMemberReadCursors(roomId, userId)
      .catch(() => ({}) as Record<string, number>);

    if (around) {
      const { items, hasMoreOlder, hasMoreNewer, olderCursor, newerCursor } =
        await this.messageService.getMessagesAround({
          roomId,
          userId,
          messageId: around,
          limit,
        });
      const [wire, totalCount] = await Promise.all([
        this.messageService.enrichForWire(items, userId),
        this.messageService.countMessages(roomId),
      ]);
      const paginated = buildAroundResponse(wire, totalCount, limit, {
        hasMoreOlder,
        hasMoreNewer,
        olderCursor,
        newerCursor,
      });
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            { ...paginated, memberReadSeq },
            paginated.data.length
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
      const wire = await this.messageService.enrichForWire(
        result.items,
        userId
      );
      const paginated = {
        ...buildTimelineResponse(
          wire,
          totalCount,
          limit,
          result.hasMore,
          result.nextCursor
        ),
        ...result.cursors,
        roomRevision: result.roomRevision,
      };
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            { ...paginated, memberReadSeq },
            paginated.data.length
              ? t("CHAT_MESSAGES_FETCHED", req.locale)
              : t("CHAT_NO_MESSAGES_FOUND", req.locale)
          )
        );
      return;
    }

    // Timestamp pagination (epoch ms) — V1 fallback. before_ts/after_ts are
    // EITHER a plain epoch-ms OR the opaque COMPOUND keyset cursor "<ms>_<id>"
    // handed back as nextCursor. The _id tiebreaker is what keeps messages that
    // share a millisecond reachable instead of skipped at a page boundary.
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
    const wire = await this.messageService.enrichForWire(result.items, userId);
    const paginated = {
      ...buildTimelineResponse(
        wire,
        result.total,
        limit,
        result.hasMore,
        result.nextCursor
      ),
      ...result.cursors,
      roomRevision: result.roomRevision,
    };
    const msg = paginated.data.length
      ? t("CHAT_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_MESSAGES_FOUND", req.locale);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse({ ...paginated, memberReadSeq }, msg));
  }

  getConversation = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const pageNumber = Number(req.query.pageNumber) || 1;
    const limit = Number(req.query.limit) || 30;
    const timestamp = req.query.timestamp
      ? Number(req.query.timestamp)
      : undefined;
    const { messages, total } = await this.messageService.getConversation({
      roomId,
      userId,
      pageNumber,
      limit,
      timestamp,
    });
    const wire = await this.messageService.enrichForWire(messages, userId);
    const paginated = buildPaginatedResponse(
      wire,
      total,
      pageNumber,
      limit,
      "createdAt"
    );
    const msg = paginated.data.length
      ? t("CHAT_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_MESSAGES_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

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
    const wire = await this.messageService.enrichForWire(messages, userId);
    const paginated = buildCursorResponse(wire, limit, "createdAt");
    const msg = paginated.items.length
      ? t("CHAT_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_MESSAGES_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  editMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const { content } = req.body as {
      content: { text: string; urls?: string[]; files?: unknown[] };
    };
    const result = await this.messageService.editMessage({
      messageId,
      userId,
      content,
    });
    // §9: build canonical ChatMessage ONCE — REST body == socket payload.
    // Groups denormalize senderName/senderAvatar on the row.
    const full = result as unknown as Record<string, unknown>;
    const editedEvent = buildChatMessageEvent({
      id: result.id,
      clientMessageId: (full.clientMessageId as string) ?? "",
      roomId: result.roomId,
      conversationType: "GROUP",
      senderId: (full.senderId as string) ?? "",
      senderName: (full.senderName as string) ?? "",
      senderAvatar: (full.senderAvatar as string) ?? "",
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
    const { reportReason } = req.body as { reportReason: string };
    const result = await this.messageService.report({
      messageId,
      reporterId: userId,
      reportReason,
    });
    res
      .status(HTTP_STATUS.CREATED)
      .json(new ApiResponse(result, t("CHAT_MESSAGE_REPORTED", req.locale)));
  });

  deleteMessage = asyncHandler(async (req: Request, res: Response) => {
    const { messageId, roomId, type } = req.body as {
      messageId: string;
      roomId: string;
      type?: "forMe" | "forEveryone";
    };
    await this.runDelete(req, res, messageId, roomId, type);
  });

  /**
   * V2 delete — same path shape as private/community (`DELETE /messages/:messageId
   * ?type=`), so a client needs no per-conversation-type special case. The room is
   * resolved from the message instead of being passed in the body.
   */
  deleteMessageV2 = asyncHandler(async (req: Request, res: Response) => {
    const messageId = req.params.messageId as string;
    const message = await this.messageService.findMessageById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    await this.runDelete(
      req,
      res,
      messageId,
      message.roomId,
      req.query.type as "forMe" | "forEveryone" | undefined
    );
  });

  private async runDelete(
    req: Request,
    res: Response,
    messageId: string,
    roomId: string,
    type: "forMe" | "forEveryone" | undefined
  ) {
    const { userId } = req.auth;
    // ABSENT `type` === "forEveryone" (backward-compatible with existing clients).
    const scope = type === "forMe" ? "forMe" : "forEveryone";

    const result =
      scope === "forMe"
        ? await this.messageService.deleteForMe(messageId, userId, roomId)
        : await this.messageService.deleteMessage(messageId, userId, roomId);

    // §2.3: canonical tombstone — REST body == socket payload byte-for-byte. The
    // `scope` round-trips so each client applies forMe (hide only for the actor,
    // keyed by deletedBy) vs forEveryone (placeholder for all).
    const tombstone = result
      ? buildDeletePayload({
          conversationType: "GROUP",
          messageId: result.id,
          roomId: result.roomId,
          scope,
          deletedBy: userId,
          sequenceNumber: result.sequenceNumber,
          deletedType:
            scope === "forMe"
              ? "SELF_DELETE"
              : ((result as { deletedType?: string }).deletedType ??
                "SELF_DELETE"),
        })
      : null;
    if (result?.roomId && tombstone) {
      await this.redis.publish(
        `conv:${result.roomId}`,
        JSON.stringify({ event: "message:delete", data: tombstone })
      );
    }

    // When deleted for everyone, check if the message was actively pinned.
    // If so: mark the pin unavailable and emit pin:updated so the banner reflects it live.
    if (result?.roomId && scope === "forEveryone") {
      const rId = result.roomId;
      void this.pinService
        .handleMessageDeleted(messageId)
        .then((affectedPin) => {
          if (!affectedPin) return;
          return this.redis.publish(
            `conv:${rId}`,
            JSON.stringify({
              event: "pin:updated",
              data: {
                roomId: rId,
                conversationId: rId,
                messageId,
                action: "pinned",
                pinnedCount: null,
                pin: { ...affectedPin, isAvailable: false },
              },
            })
          );
        })
        .catch((err: unknown) => {
          logger.warn(
            `deleteMessage|pin hook failed messageId=${messageId}: ${String(err)}`
          );
        });
    }

    // delete-for-everyone: recalc the SHARED snapshot and bump every member's
    // list — each recipient re-resolved to THEIR own visible preview so a member
    // who personally hid the new previous-visible message never sees it.
    if (result?.roomId && scope === "forEveryone") {
      const rId = result.roomId;
      void this.messageService
        .recalculateLastMessageAfterDelete(rId, messageId)
        .then((recalc) => {
          if (recalc === null) return; // not the last message — no-op
          const preview = buildMessagePreview(
            recalc.messageType,
            recalc.content
          );
          publishConvUpdatedSafe({
            redis: this.redis,
            type: "GROUP",
            roomId: rId,
            fetchRecipients: () => this.messageService.getActiveMemberIds(rId),
            // Per-recipient correctness: a member who personally hid the new
            // shared previous-visible message gets THEIR own preview instead.
            resolveOverrides: (recipientIds) =>
              this.messageService
                .resolveForEveryoneOverrides(
                  rId,
                  recalc.prevMessageId,
                  recipientIds
                )
                .then((raw) => renderConvOverrides(raw)),
            senderId: recalc.senderId ?? "",
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

    // delete-for-me: TARGETED conv:updated to the deleting user's devices only.
    // The shared GroupRoom snapshot is untouched (other members unaffected), and
    // the bump fires ONLY when the deleted message was the viewer's effective
    // last visible message (else hiding it changes nothing in their list).
    if (result?.roomId && scope === "forMe") {
      const rId = result.roomId;
      const deletedAt = result.createdAt;
      void this.messageService
        .recalculateLastMessageAfterDeleteForMe(rId, deletedAt, userId)
        .then((recalc) => {
          if (!recalc || !recalc.wasEffectiveLast) return; // no-op: not the last
          const preview = recalc.hasLastMessage
            ? buildMessagePreview(recalc.messageType, recalc.content)
            : "";
          publishConvUpdatedSafe({
            redis: this.redis,
            type: "GROUP",
            roomId: rId,
            recipientIds: [userId],
            senderId: recalc.senderId ?? "",
            lastMessageId: recalc.prevMessageId ?? "",
            lastMessageAt: recalc.createdAt.getTime(),
            preview: { contentType: recalc.messageType, text: preview },
          });
        })
        .catch(() => {});
    }

    res.status(HTTP_STATUS.OK).json(new ApiResponse(tombstone));
  }

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

  // V2 §2.5: pin a group message and broadcast pin:updated to conv:<roomId>.
  // Only one active pin per room (parity with Community) — pinning a 2nd
  // message replaces the 1st, so a switch also emits the replaced pin's unpin.
  pin = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const messageId = req.params.messageId as string;
    const result = await this.pinService.pin({ roomId, messageId, userId });
    if (!result.idempotent) {
      if (result.replacedPin) {
        await this.redis.publish(
          `conv:${roomId}`,
          JSON.stringify({
            event: "pin:updated",
            data: {
              roomId,
              conversationId: roomId,
              messageId: result.replacedPin.messageId,
              unpinnedBy: userId,
              action: "unpinned",
              pinnedCount: null,
            },
          })
        );
      }
      const pinnedAt =
        result.pin.pinnedAt instanceof Date
          ? result.pin.pinnedAt.getTime()
          : Date.now();
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
    }
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
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const cursor =
      req.query.cursor != null ? String(req.query.cursor) : undefined;
    if (!query) {
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            { data: [], hasMore: false, nextCursor: null },
            t("CHAT_NO_MESSAGES_FOUND", req.locale)
          )
        );
      return;
    }
    const result = await this.messageService.searchMessages({
      roomId,
      userId,
      query,
      limit,
      cursor,
    });
    const wire = await this.messageService.enrichForWire(
      result.messages,
      userId
    );
    const data = wire.map((m) => ({
      ...m,
      searchScore: result.scores.get((m as { id: string }).id) ?? 0,
    }));
    const msg = data.length
      ? t("CHAT_MESSAGES_SEARCHED", req.locale)
      : t("CHAT_NO_MESSAGES_FOUND", req.locale);
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          { data, hasMore: result.hasMore, nextCursor: result.nextCursor },
          msg
        )
      );
  });

  forwardMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const { targetRoomId, clientMessageId, senderName, senderAvatar } =
      req.body as {
        targetRoomId: string;
        clientMessageId?: string | null;
        senderName?: string;
        senderAvatar?: string;
      };
    const result = await this.messageService.forwardMessage({
      sourceMessageId: messageId,
      // :roomId path param is the SOURCE room — bind the source message to it so
      // a caller can't forward (and thereby read) a message from a group they're not in.
      sourceRoomId: req.params.roomId as string,
      targetRoomId,
      senderId: userId,
      senderName: senderName ?? "",
      senderAvatar: senderAvatar ?? "",
      clientMessageId: clientMessageId ?? null,
    });
    // §1/§9: build canonical ChatMessage ONCE — REST body == socket payload.
    const full = result as unknown as Record<string, unknown>;
    const forwardedEvent = buildChatMessageEvent({
      id: result.id,
      clientMessageId: (full.clientMessageId as string) ?? "",
      roomId: targetRoomId,
      conversationType: "GROUP",
      senderId: userId,
      senderName: senderName ?? (full.senderName as string) ?? "",
      senderAvatar: senderAvatar ?? (full.senderAvatar as string) ?? "",
      senderRole: (full.senderRole as string) ?? "",
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
    // Fire-and-forget bump (incl. member fetch) — must never delay the HTTP response.
    publishConvUpdatedSafe({
      redis: this.redis,
      type: "GROUP",
      roomId: targetRoomId,
      fetchRecipients: () =>
        this.messageService.getActiveMemberIds(targetRoomId),
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

  getMessageReadBy = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const result = await this.messageService.getMessageReadBy({
      roomId: req.params.roomId as string,
      messageId: req.params.messageId as string,
      requesterId: userId,
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
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
   * POST /groups/:roomId/messages/:messageId/reactions — add the caller's `emoji`
   * reaction. Delegates to the orchestrator (active-member guard + idempotent
   * toggle-ON + message:reaction broadcast). Returns the updated ChatReactionGroup[]
   * under `{ reactions }`. Idempotent: re-adding an existing reaction is a no-op.
   */
  /** V2 `POST /messages/:messageId/react` — see PrivateMessageController.setReactionV2. */
  setReactionV2 = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const { emoji } = req.body as { emoji: string };
    const message = await this.messageService.findMessageById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    const { reactions } = await this.orchestrator.reactDirect({
      conversationType: "GROUP",
      roomId: message.roomId,
      messageId,
      userId,
      emoji,
      op: "set",
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse({ reactions }));
  });

  addReaction = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const messageId = req.params.messageId as string;
    const { emoji } = req.body as { emoji: string };
    const { reactions } = await this.orchestrator.reactDirect({
      conversationType: "GROUP",
      roomId,
      messageId,
      userId,
      emoji,
      op: "add",
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse({ reactions }));
  });

  /**
   * DELETE /groups/:roomId/messages/:messageId/reactions/:emoji — remove the
   * caller's `emoji` reaction. Delegates to the orchestrator (active-member guard +
   * idempotent toggle-OFF + message:reaction broadcast). Returns the updated
   * ChatReactionGroup[]. Idempotent: removing an absent reaction is a no-op.
   */
  removeReaction = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const messageId = req.params.messageId as string;
    const emoji = req.params.emoji as string;
    const { reactions } = await this.orchestrator.reactDirect({
      conversationType: "GROUP",
      roomId,
      messageId,
      userId,
      emoji,
      op: "remove",
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse({ reactions }));
  });
}
