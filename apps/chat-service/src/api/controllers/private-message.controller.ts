import type { Request, Response } from "express";
import type { Redis, Cluster } from "ioredis";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";
import { NotFoundError } from "@aimess/errors";

import {
  buildPaginatedResponse,
  buildCursorResponse,
  buildTimelineResponse,
  buildAroundResponse,
  parseTsCursor,
} from "../../lib/pagination.js";
import { publishConvUpdatedSafe } from "../../events/publish-conv-updated.js";
import { buildMessagePreview } from "../../events/publish-message-sent.js";
import { renderConvOverrides } from "../../lib/recipient-override-render.js";
import { publishConvEffectiveLastLoss } from "../../events/publish-effective-last-loss.js";
import { recalcConvAfterSystemLineRetraction } from "../../events/recalc-conv-after-retraction.js";
import { unpinAfterDelete } from "../../lib/pin-after-delete.js";
import {
  autoDeleteWireFields,
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
   * `GET /private/rooms/:roomId/messages` — the private room timeline. Supports
   * every pagination axis: `before_ts`/`after_ts` (compound `(createdAt, _id)`
   * keyset), the gap-safe `before_seq`/`after_seq` sequence keyset, and
   * `around=<messageId>` for jump-to-message. See {@link listMessages}.
   */
  getMessages = asyncHandler((req: Request, res: Response) =>
    this.listMessages(req, res, "before_ts", "after_ts")
  );

  /**
   * `GET /private/rooms/:roomId/changes` — the ZERO-LOSS changes feed.
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

    // Receipts move without bumping `revision`, so the changes feed alone would
    // never tell a reconnecting sender that the peer read or received anything
    // while they were away. Resolved alongside the page; both best-effort.
    const [result, peerReadSeq, peerDeliveredSeq] = await Promise.all([
      this.messageService.getChanges({
        roomId,
        userId,
        sinceRevision,
        limit,
      }),
      this.messageService.getPeerReadSeq(roomId, userId).catch(() => 0),
      this.messageService.getPeerDeliveredSeq(roomId, userId).catch(() => 0),
    ]);

    res.status(HTTP_STATUS.OK).json(
      new ApiResponse(
        {
          items: result.items,
          roomRevision: result.roomRevision,
          resetRequired: result.resetRequired,
          hasMore: result.hasMore,
          nextRevisionCursor: result.nextRevisionCursor,
          peerReadSeq,
          peerDeliveredSeq,
        },
        result.items.length
          ? t("CHAT_MESSAGES_FETCHED", req.locale)
          : t("CHAT_NO_MESSAGES_FOUND", req.locale)
      )
    );
  });

  /**
   * The private room timeline. `olderKey`/`newerKey` name the query params that
   * carry the opaque compound `(createdAt, _id)` cursor.
   *
   * Pagination precedence: `around` (jump-to-message) → `before_seq`/`after_seq`
   * (gap-safe sequence keyset) → the compound timestamp keyset → newest page.
   */
  private async listMessages(
    req: Request,
    res: Response,
    olderKey: "before_ts",
    newerKey: "after_ts"
  ) {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const limit = Number(req.query.limit) || 30;

    // Prefer seq-based keyset cursors (gap-safe) when present.
    // before_seq → sequenceNumber < seq (newest-first);
    // after_seq  → sequenceNumber > seq (oldest-first);
    // around=<messageId> → window centered on a message (jump-to-message).
    const beforeSeq =
      req.query.before_seq != null ? Number(req.query.before_seq) : undefined;
    const afterSeq =
      req.query.after_seq != null ? Number(req.query.after_seq) : undefined;
    const around = req.query.around as string | undefined;

    // The peer's read high-water mark (as a sequenceNumber) — included on every
    // page so the FE can hydrate each of MY OWN messages' seen/delivered tick
    // WITHOUT waiting for a live `message:read` event (fixes ticks resetting to
    // "sent" on refresh/reconnect; see PrivateMessageService.getPeerReadSeq).
    // peerDeliveredSeq is the parallel signal for the DELIVERED (✓✓ grey) tick
    // when the peer has received but not yet opened the chat — hydrated from
    // the newest MY-message the peer appears in `deliveredTo` on.
    // pinnedMessage rides along on every page so the pinned banner hydrates from
    // the timeline call itself instead of a second round-trip.
    const [peerReadSeq, peerDeliveredSeq, pinnedMessage] = await Promise.all([
      this.messageService.getPeerReadSeq(roomId, userId),
      this.messageService.getPeerDeliveredSeq(roomId, userId),
      this.pinService.getActivePinSummary(roomId, userId),
    ]);

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
            { ...paginated, peerReadSeq, peerDeliveredSeq, pinnedMessage },
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
      const paginated = {
        ...buildTimelineResponse(
          enriched,
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
            { ...paginated, peerReadSeq, peerDeliveredSeq, pinnedMessage },
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
    const paginated = {
      ...buildTimelineResponse(
        enriched,
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
      .json(
        new ApiResponse(
          { ...paginated, peerReadSeq, peerDeliveredSeq, pinnedMessage },
          msg
        )
      );
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
      revision: result.revision,
      clientMessageId: result.clientMessageId,
      deletedAt: result.deletedAt?.getTime() ?? Date.now(),
    });
    if (result.roomId) {
      await this.redis.publish(
        `conv:${result.roomId}`,
        JSON.stringify({ event: "message:delete", data: tombstone })
      );
    }

    // Keep pin state consistent with the delete: forEveryone unpins for the
    // whole room, forMe only for the deleting user. See lib/pin-after-delete.
    // The pin hook can RETRACT the "<actor> pinned a message" system line, which
    // is itself a room message and is very often the room's current last one.
    // The recalculation below must therefore run AFTER it — a recalc racing the
    // retraction re-points the snapshot at a line that is about to be
    // tombstoned, and the list then previews a deleted message forever.
    let pinCleanup: Promise<void> = Promise.resolve();
    if (result.roomId) {
      pinCleanup = unpinAfterDelete({
        redis: this.redis,
        pinService: this.pinService,
        kind: "DIRECT",
        roomId: result.roomId,
        messageId,
        userId,
        scope: type === "forEveryone" ? "forEveryone" : "forMe",
      });
    }

    // For delete-for-everyone: recalculate and broadcast the new list preview
    // to all participants so the conversation list never shows "Message deleted".
    if (type === "forEveryone" && result.roomId) {
      void pinCleanup
        .then(() =>
          this.messageService.recalculateLastMessageAfterDelete(
            result.roomId,
            messageId
          )
        )
        .then((recalc) => {
          if (recalc === null) {
            // The SHARED snapshot did not move — but a participant who had
            // hidden everything newer than the removed message was previewing
            // IT. See events/publish-effective-last-loss.ts.
            return publishConvEffectiveLastLoss({
              redis: this.redis,
              type: "PRIVATE",
              roomId: result.roomId,
              recipientIds: () =>
                Promise.resolve(
                  [
                    (result as { senderId?: string }).senderId ?? userId,
                    (result as { receiverId?: string }).receiverId ?? "",
                  ].filter(Boolean) as string[]
                ),
              deletedMessageSeq: result.sequenceNumber ?? 0,
              resolveLosers: (rid, seq, ids) =>
                this.messageService.resolveEffectiveLastLosers(rid, seq, ids),
            });
          }
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
            // Absolute post-delete badge for both participants. The unread
            // counter was already decremented by the delete itself; without
            // this the client keeps counting a message that no longer exists.
            resolveUnreadCounts: () =>
              this.messageService.getUnreadCountsByUser(result.roomId),
            // Without this the bump is discarded by the client's monotonic list
            // guard — it points BACKWARD at the previous visible message.
            deleteRecalc: true,
            // The DELETE's own room revision, not the surviving message's — this
            // projection update is newer than everything before it even though its
            // `lastMessageAt` is older. Same rule as the socket path's orchestrator.
            projectionRevision: result.revision ?? 0,
            senderId: recalc.senderId,
            // A PRIVATE row is titled by the peer, never by a
            // "<sender>: <preview>" prefix, so there is no name to carry here
            // (the recalc does not resolve one). "" is the documented
            // sender-less value, not an omission.
            senderName: "",
            lastMessageId: recalc.prevMessageId ?? "",
            lastMessageAt: recalc.createdAt.getTime(),
            preview: {
              contentType: recalc.messageType,
              text: preview,
              clientMessageId: recalc.clientMessageId,
              seq: recalc.sequenceNumber,
              revision: recalc.revision,
              createdAt: recalc.createdAt.getTime(),
            },
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
          result.sequenceNumber ?? 0,
          userId
        )
        .then((recalc) => {
          // Skip unless the deleted message was the viewer's effective last
          // visible message — hiding an older message changes nothing in their list.
          if (recalc === null || !recalc.wasEffectiveLast) return;
          const preview = recalc.hasLastMessage
            ? buildMessagePreview(recalc.messageType, recalc.content)
            : "";
          publishConvUpdatedSafe({
            redis: this.redis,
            type: "PRIVATE",
            roomId: result.roomId,
            recipientIds: [userId],
            // Only the hiding user's own badge can move on a delete-for-me.
            resolveUnreadCounts: () =>
              this.messageService.getUnreadCountsByUser(result.roomId),
            deleteRecalc: true,
            senderId: recalc.senderId,
            // A PRIVATE row is titled by the peer, never by a
            // "<sender>: <preview>" prefix, so there is no name to carry here
            // (the recalc does not resolve one). "" is the documented
            // sender-less value, not an omission.
            senderName: "",
            lastMessageId: recalc.prevMessageId ?? "",
            // NEVER a stale createdAt when nothing visible remains: 0 is the
            // documented "viewer has nothing left" signal and sorts to the
            // bottom. Reusing the removed row's time pins it to the top.
            lastMessageAt: recalc.hasLastMessage
              ? recalc.createdAt.getTime()
              : 0,
            preview: {
              contentType: recalc.messageType,
              text: preview,
              clientMessageId: recalc.clientMessageId,
              seq: recalc.sequenceNumber,
              revision: recalc.revision,
              createdAt: recalc.createdAt.getTime(),
            },
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
  // updates live for everyone in the room (multi-device consistent). Only one
  // active pin per room (parity with Community) — pinning a 2nd message
  // replaces the 1st, so a switch also emits the replaced pin's unpin event.
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
              pinnedCount: null, // unchanged; the pinned event right after carries the settled count
            },
          })
        );
      }
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
            // See the group controller: the pinned snapshot's text lets a client
            // render the banner for a message outside its loaded window.
            text:
              (result.pin.contentPinned as unknown as { text?: string } | null)
                ?.text ?? "",
          },
        })
      );
    }
    // Switching pins retracts the REPLACED pin's "pinned a message" system
    // line. That line is an ordinary room message and is often the room's last
    // one, so the snapshot must be repaired or the list previews a tombstone.
    if (result.replacedPin?.pinSystemMessageId) {
      await recalcConvAfterSystemLineRetraction({
        redis: this.redis,
        type: "PRIVATE",
        roomId,
        retractedMessageId: result.replacedPin.pinSystemMessageId,
        messageService: this.messageService,
        fetchRecipients: () => this.messageService.getParticipants(roomId),
      });
    }
    res
      .status(HTTP_STATUS.CREATED)
      .json(new ApiResponse(result, t("CHAT_MESSAGE_PINNED", req.locale)));
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
    // The unpin retracted the "pinned a message" system line — see the pin
    // handler above for why the room snapshot has to be repaired after it.
    if (result.retractedSystemMessageId) {
      await recalcConvAfterSystemLineRetraction({
        redis: this.redis,
        type: "PRIVATE",
        roomId,
        retractedMessageId: result.retractedSystemMessageId,
        messageService: this.messageService,
        fetchRecipients: () => this.messageService.getParticipants(roomId),
      });
    }
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_MESSAGE_UNPINNED", req.locale)));
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
    const enriched = await this.messageService.enrichMessages(result.messages);
    const data = enriched.map((m) => ({
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
      ...autoDeleteWireFields(result),
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
      // PRIVATE rows carry no sender prefix — see the delete-recalc bumps above.
      senderName: "",
      lastMessageId: result.id,
      lastMessageAt: result.createdAt?.getTime() ?? Date.now(),
      preview: {
        contentType: result.messageType,
        text: buildMessagePreview(result.messageType, result.content),
        clientMessageId: result.clientMessageId ?? null,
        seq: result.sequenceNumber ?? 0,
        revision: result.revision ?? 0,
        createdAt: result.createdAt?.getTime() ?? Date.now(),
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
   * `POST /private/messages/:messageId/react` — single-write SET, matching the
   * community REST react. The room is resolved from the message, so the offline
   * queue can drain a reaction with only (messageId, emoji) regardless of
   * conversation type. The room-scoped `addReaction`/`removeReaction` toggle pair
   * stays available for clients that already know the room.
   */
  setReaction = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const { emoji } = req.body as { emoji: string };
    const message = await this.messageService.findMessageById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    const { reactions } = await this.orchestrator.reactDirect({
      conversationType: "PRIVATE",
      roomId: message.roomId,
      messageId,
      userId,
      emoji,
      op: "set",
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
      // §4 — an edit does not restart the timer; the deadline rides along so an
      // edited bubble keeps showing the same countdown instead of losing it.
      ...autoDeleteWireFields(result),
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
    const { reason, description, roomId } = req.body as {
      reason: string;
      description?: string;
      roomId?: string;
    };
    const result = await this.messageService.reportMessage({
      messageId,
      reporterId: userId,
      reason,
      description,
      roomId,
    });
    res
      .status(HTTP_STATUS.CREATED)
      .json(new ApiResponse(result, t("CHAT_MESSAGE_REPORTED", req.locale)));
  });
}
