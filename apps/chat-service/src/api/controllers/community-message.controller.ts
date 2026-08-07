import type { Request, Response } from "express";
import type { Redis, Cluster } from "ioredis";

import { logger } from "@aimess/logger";
import { BadRequestError, NotFoundError } from "@aimess/errors";
import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t, buildReactionActivityText } from "@aimess/constants";

import {
  buildPaginatedResponse,
  buildCursorResponse,
  buildTimelineResponse,
  buildAroundResponse,
} from "../../lib/pagination.js";
import {
  normalizeMessageType,
  buildDeletePayload,
} from "../../lib/chat-message.serializer.js";
import {
  buildAvailableContext,
  buildUnavailableContext,
} from "../../lib/message-context.js";
import { toCanonicalMessages } from "../../lib/canonical-message.js";
import {
  publishCommunityUpdatedSafe,
  type RecipientBump,
} from "../../events/publish-conv-updated.js";
import { publishCommunityActivitySafe } from "../../events/publish-community-activity.js";
import { renderCommunityOverrides } from "../../lib/recipient-override-render.js";
import { getCommunityReconcileClient } from "../../grpc/community.client.js";
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
      communityName?: string;
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
      communityName: body.communityName,
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
   * POST /community/rooms/:roomId/read — mark this community room read up to
   * `upToMessageId`, broadcasting `community:message:read` to the room (and
   * `community:read_sync` to the reader's own other devices) — matching
   * private/group's live per-message read receipt instead of the previous
   * read-to-now-only, no-broadcast behavior.
   */
  markRead = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const { communityId, upToMessageId } = req.body as {
      communityId: string;
      upToMessageId: string;
    };
    const result = await this.service.markMessageRead({
      communityId,
      roomId,
      readerId: userId,
      upToMessageId,
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  /**
   * `GET /chat/community/rooms/:roomId/messages` — the community room timeline.
   *
   * Pagination precedence:
   *   `around`                     → jump-to-message window (ts-anchored)
   *   `before_seq` / `after_seq`   → gap-safe sequenceNumber keyset (OPT-IN; only
   *                                  trustworthy on rooms with seq backfilled)
   *   `after_ts`                   → incremental sync (updatedAt >=, incl. tombstones)
   *   `before_ts` / none           → compound `(createdAt, _id)` history keyset
   */
  getMessages = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const limit = Number(req.query.limit) || 30;
    const around = req.query.around as string | undefined;

    if (around) {
      const {
        items,
        total,
        hasMoreOlder,
        hasMoreNewer,
        olderCursor,
        newerCursor,
      } = await this.service.getMessagesAround({
        roomId,
        userId,
        messageId: around,
        limit,
      });
      const paginated = buildAroundResponse(
        toCanonicalMessages(items as unknown as Record<string, unknown>[]),
        total,
        limit,
        { hasMoreOlder, hasMoreNewer, olderCursor, newerCursor }
      );
      const pinnedMessage = await this.pinService.getActivePinSummary(roomId);
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            { ...paginated, pinnedMessage },
            items.length
              ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
              : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale)
          )
        );
      return;
    }

    // Gap-safe sequenceNumber keyset (opt-in). Checked before the *_ts params so
    // a client that sends both gets the monotonic axis. `sequenceNumber` matches
    // display order by definition, whereas `(createdAt, id)` can invert — but it
    // is only correct on rooms whose seq has been backfilled, which is why this
    // stays opt-in rather than becoming the default.
    const beforeSeq =
      req.query.before_seq != null ? Number(req.query.before_seq) : undefined;
    const afterSeq =
      req.query.after_seq != null ? Number(req.query.after_seq) : undefined;

    if (beforeSeq != null || afterSeq != null) {
      const result = await this.service.getMessagesSeqKeyset({
        roomId,
        userId,
        direction: afterSeq != null ? "after" : "before",
        seq: afterSeq ?? beforeSeq ?? null,
        limit,
      });
      const paginated = {
        ...buildTimelineResponse(
          toCanonicalMessages(
            result.items as unknown as Record<string, unknown>[]
          ),
          result.total,
          limit,
          result.hasMore,
          result.nextCursor
        ),
        ...result.cursors,
        roomRevision: result.roomRevision,
      };
      const pinnedMessage = await this.pinService.getActivePinSummary(roomId);
      const msg = paginated.data.length
        ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
        : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale);
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse({ ...paginated, pinnedMessage }, msg));
      return;
    }

    // `before_ts` is the history-scroll cursor. It is EITHER a plain epoch-ms
    // (a first/manual call) OR the opaque COMPOUND cursor "<ms>_<objectId>"
    // handed back as `nextCursor` from a previous page. Splitting on "_" yields
    // the keyset (ts, id) — the id tiebreaker is what makes messages that share
    // a millisecond reachable instead of being skipped at a page boundary.
    const rawBeforeTs =
      req.query.before_ts != null ? String(req.query.before_ts) : undefined;
    let beforeTs: number | undefined;
    let beforeId: string | null = null;
    if (rawBeforeTs != null && rawBeforeTs !== "") {
      const sep = rawBeforeTs.indexOf("_");
      const msPart = sep === -1 ? rawBeforeTs : rawBeforeTs.slice(0, sep);
      const idPart = sep === -1 ? "" : rawBeforeTs.slice(sep + 1);
      beforeTs = Number(msPart);
      beforeId = idPart || null;
    }
    const afterTs =
      req.query.after_ts != null ? Number(req.query.after_ts) : undefined;

    // Incremental-sync mode: after_ts only.
    // Returns every message (new, edited, reacted, deleted tombstone) whose
    // updatedAt >= after_ts. Feed the returned nextCursor as the next after_ts.
    if (afterTs != null) {
      if (!Number.isFinite(afterTs) || afterTs < 0) {
        throw new BadRequestError("CHAT_INVALID_SINCE_TS");
      }
      const result = await this.service.getMessagesSince({
        roomId,
        userId,
        fromTs: new Date(afterTs),
        limit,
      });
      const pinnedMessage = await this.pinService.getActivePinSummary(roomId);
      const msg = result.items.length
        ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
        : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale);
      res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
          {
            data: toCanonicalMessages(result.items),
            hasMore: result.hasMore,
            // Store this as the next after_ts to page forward or re-sync.
            nextCursor: result.nextCursor,
            pinnedMessage,
          },
          msg
        )
      );
      return;
    }

    // Scroll / history mode: before_ts → newest-first older page, omit → latest
    // page. (after_ts was handled above via incremental sync and returned.)
    const hasBefore = beforeTs != null;
    const result = await this.service.getMessagesTimeline({
      roomId,
      userId,
      direction: "before",
      ts: new Date(hasBefore ? beforeTs! : Date.now()),
      boundaryId: beforeId,
      // First page (no before_ts) includes the newest message; a bare-ms cursor
      // is treated as exclusive so it never re-returns its own boundary row.
      inclusive: !hasBefore,
      limit,
    });
    // Legacy hasMore/nextCursor stay direction-correct; the bidirectional
    // continuation (hasMoreOlder/hasMoreNewer/olderCursor/newerCursor) is
    // ADDITIVE on every page so a client can page BOTH ways from any window.
    const paginated = {
      ...buildTimelineResponse(
        toCanonicalMessages(
          result.items as unknown as Record<string, unknown>[]
        ),
        result.total,
        limit,
        result.hasMore,
        result.nextCursor
      ),
      ...result.cursors,
      roomRevision: result.roomRevision,
    };
    const pinnedMessage = await this.pinService.getActivePinSummary(roomId);
    const msg = paginated.data.length
      ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse({ ...paginated, pinnedMessage }, msg));
  });

  /**
   * `GET /chat/community/rooms/:roomId/changes` — the ZERO-LOSS
   * changes feed. Returns every message whose room CHANGE `revision >
   * since_revision` (inserts AND edits/deletes/reactions), current state, ordered
   * revision ASC, plus `roomRevision` (new high-water), `resetRequired` (deep-gap
   * re-baseline), `pinnedMessage`, and a `nextRevisionCursor` to drain. This is
   * what closes mutation-loss that V2 `after_seq` (inserts only) can't.
   */
  getChanges = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const sinceRevision = Number(req.query.since_revision) || 0;
    const limit = Number(req.query.limit) || 100;

    const [result, pinnedMessage] = await Promise.all([
      this.service.getChanges({ roomId, userId, sinceRevision, limit }),
      this.pinService.getActivePinSummary(roomId),
    ]);

    res.status(HTTP_STATUS.OK).json(
      new ApiResponse(
        {
          items: result.items,
          roomRevision: result.roomRevision,
          resetRequired: result.resetRequired,
          hasMore: result.hasMore,
          nextRevisionCursor: result.nextRevisionCursor,
          pinnedMessage,
        },
        result.items.length
          ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
          : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale)
      )
    );
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
    // §1: community edit uses thin payload (not buildChatMessageEvent) until Phase 3.
    // REST body == socket payload so the client uses one shape for both.
    const editedPayload = {
      messageId: result.id,
      communityId: result.roomId,
      roomId: result.roomId,
      senderId: result.sentBy,
      message: result.message ?? "",
      contentType: normalizeMessageType(result.messageType),
      isEdited: true,
      editedAt:
        result.editedAt instanceof Date
          ? result.editedAt.getTime()
          : Date.now(),
      // Zero-loss CHANGE cursor for live gap detection.
      revision: (result as unknown as { revision?: number }).revision ?? 0,
    };
    await this.redis.publish(
      `community:${result.roomId}`,
      JSON.stringify({ event: "community:message:edited", data: editedPayload })
    );
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(editedPayload, t("CHAT_MESSAGE_EDITED", req.locale))
      );
  });

  /**
   * POST /community/rooms/:roomId/messages/:messageId/forward — forward a
   * community message into another community room. Delegates to the
   * orchestrator's `forwardCommunity` (source-room-membership IDOR guard +
   * target-membership check + `community:message:new` broadcast + activity
   * bump + FCM push), matching the private/group forward contract instead of
   * leaving community forward REST-only-missing while gRPC/socket already work.
   */
  forwardMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const sourceRoomId = req.params.roomId as string;
    const { targetCommunityId, targetRoomId, clientMessageId } = req.body as {
      targetCommunityId: string;
      targetRoomId: string;
      clientMessageId?: string | null;
    };
    const result = await this.orchestrator.forwardCommunity({
      sourceMessageId: messageId,
      sourceCommunityId: sourceRoomId,
      targetCommunityId,
      targetRoomId,
      senderId: userId,
      clientMessageId: clientMessageId ?? null,
    });
    res
      .status(HTTP_STATUS.CREATED)
      .json(
        new ApiResponse(result.message, t("CHAT_MESSAGE_FORWARDED", req.locale))
      );
  });

  reactToMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const { emoji, mode } = req.body as {
      communityId: string;
      emoji: string;
      mode?: string;
    };

    const result = await this.service.reactToMessage({
      messageId,
      userId,
      emoji,
      mode,
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
            // Zero-loss CHANGE cursor for live gap detection.
            revision: result.revision,
          },
        })
      )
      .catch((err: unknown) => {
        logger.warn(
          `community:message:reaction publish failed: ${String(err)}`
        );
      });

    // Reactions are a fully separate OVERLAY on top of lastActivity — they
    // NEVER touch the canonical `lastActivityAt/Type/Preview/Username/UserId`
    // columns (that stays exactly what a real message/system event last set,
    // untouched, forever — the rest of the community's view is never affected
    // by a reaction). The overlay is visible ONLY to the reactor and (if
    // different) the reacted-to message's owner; every other member sees
    // nothing different. Mirrors the gRPC reactToCommunityMessage handler.
    const isSelfReaction = result.targetUserId === userId;

    if (result.added) {
      const reactedAt = Date.now();
      const { selfPreview, targetPreview } = buildReactionActivityText({
        actorName: result.actorName,
        targetMessagePreview: result.targetMessagePreview,
        emoji,
        isSelfReaction,
      });
      publishCommunityActivitySafe({
        communityId: result.roomId,
        lastMessageAt: new Date(reactedAt).toISOString(),
        lastMessageId: result.messageId,
        senderUserId: userId,
        senderUsername: result.actorName,
        messagePreview: "",
        type: "reaction_added",
        reactionMessageId: result.messageId,
        reactionEmoji: emoji,
        reactionActorId: userId,
        reactionActorPreview: selfPreview,
        reactionTargetId: isSelfReaction ? null : result.targetUserId,
        reactionTargetPreview: isSelfReaction ? null : targetPreview,
      });

      // Synchronous companion to the publish above — AWAITED before the
      // response returns, so a client that reloads immediately after seeing
      // this reaction can never race ahead of the DB write (the async queue
      // publish just above is best-effort/eventual and was the sole path
      // before this; a reload could land in the gap and see the reaction
      // "disappear" until the queue caught up). Never blocks the reaction on
      // failure — errors resolve to `false`, and the queue publish remains
      // the backstop.
      await getCommunityReconcileClient().updateReactionActivity({
        communityId: result.roomId,
        added: true,
        messageId: result.messageId,
        emoji,
        actorId: userId,
        actorPreview: selfPreview,
        targetId: isSelfReaction ? null : result.targetUserId,
        targetPreview: isSelfReaction ? null : targetPreview,
        reactedAt,
      });

      // Live bump — reused pipeline, but the recipient list is restricted to
      // JUST the actor (+ target, if a different person): everyone else must
      // see no change at all, so `fetchMembers` returns only those 1-2 ids
      // instead of the full membership. The actor gets `selfPreview` via the
      // existing subjectUserId mechanism; the target (when different) gets
      // `targetPreview` via a per-recipient override — same delete-for-
      // everyone-style mechanism already used elsewhere, not a new one.
      publishCommunityUpdatedSafe({
        redis: this.redis,
        communityId: result.roomId,
        roomId: result.roomId,
        fetchMembers: () =>
          Promise.resolve(
            isSelfReaction ? [userId] : [userId, result.targetUserId]
          ),
        senderId: userId,
        senderName: "",
        lastMessageId: result.messageId,
        lastMessageAt: reactedAt,
        preview: { contentType: "SYSTEM", text: selfPreview },
        subjectUserId: userId,
        selfPreview,
        ...(isSelfReaction
          ? {}
          : {
              resolveOverrides: () =>
                Promise.resolve(
                  new Map([
                    [
                      result.targetUserId,
                      {
                        lastMessageId: result.messageId,
                        lastMessageAt: reactedAt,
                        senderId: userId,
                        senderName: result.actorName,
                        preview: { contentType: "SYSTEM", text: targetPreview },
                      },
                    ],
                  ])
                ),
            }),
      });
    } else {
      // Removed — tell community-service to clear the overlay IF this exact
      // (messageId, emoji, actorId) is the one currently shown; a removal of
      // some OTHER, non-displayed reaction is a safe no-op there (identity
      // match is authoritative and lives entirely in community-service).
      publishCommunityActivitySafe({
        communityId: result.roomId,
        lastMessageAt: new Date().toISOString(),
        lastMessageId: result.messageId,
        senderUserId: userId,
        senderUsername: result.actorName,
        messagePreview: "",
        type: "reaction_removed",
        reactionMessageId: result.messageId,
        reactionEmoji: emoji,
        reactionActorId: userId,
      });

      // Synchronous companion — see the ADD branch's comment above for why
      // this is awaited before the response, not just fire-and-forget.
      await getCommunityReconcileClient().updateReactionActivity({
        communityId: result.roomId,
        added: false,
        messageId: result.messageId,
        emoji,
        actorId: userId,
      });

      // Best-effort live nudge for the two people who might have been shown
      // this reaction: refresh them to the room's real latest activity. Safe
      // even when this wasn't the displayed reaction (same value, no visual
      // change) — no identity check needed on this side.
      //
      // This MUST go through `resolveOverrides` (a RecipientBump per
      // recipient), NOT the plain shared-preview params, for two reasons that
      // bit us before the fix (see community-system-message-delivery-style
      // regression test for reactions):
      //  1. `lastMessageAt` here is deliberately `Date.now()`, not the reverted
      //     message's own `createdAt` — a client that only applies a bump when
      //     its timestamp is newer than what it already has (the reaction's own
      //     `now()` bump) would otherwise silently drop this revert and leave
      //     the removed reaction's preview stuck on screen.
      //  2. The override branch forces `unread:false` — exactly the same
      //     "never raise an unread badge" rule already documented on
      //     `publishConvUpdated`'s override handling — because this is a revert
      //     of already-seen content, never a new message.
      void this.service
        .getLatestRealActivityForLiveBump(result.roomId)
        .then((recalc) => {
          if (!recalc.hasLastMessage) return;
          const revertAt = Date.now();
          const revertBump: RecipientBump = {
            lastMessageId: recalc.prevMessageId ?? "",
            lastMessageAt: revertAt,
            senderId: recalc.sentBy,
            senderName: recalc.senderName,
            preview: {
              contentType: normalizeMessageType(recalc.messageType),
              text: recalc.preview,
            },
          };
          const recipients = isSelfReaction
            ? [userId]
            : [userId, result.targetUserId];
          publishCommunityUpdatedSafe({
            redis: this.redis,
            communityId: result.roomId,
            roomId: result.roomId,
            fetchMembers: () => Promise.resolve(recipients),
            senderId: recalc.sentBy,
            senderName: recalc.senderName,
            lastMessageId: revertBump.lastMessageId,
            lastMessageAt: revertAt,
            preview: revertBump.preview,
            resolveOverrides: () =>
              Promise.resolve(
                new Map(recipients.map((id) => [id, revertBump]))
              ),
          });
        })
        .catch((err: unknown) => {
          logger.warn(
            `reactToMessage|getLatestRealActivityForLiveBump failed roomId=${result.roomId}: ${String(err)}`
          );
        });
    }

    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_MESSAGE_REACTED", req.locale)));
  });

  deleteMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const type = req.query.type as string;

    const result =
      type === "forEveryone"
        ? await this.service.deleteForAll(messageId, userId)
        : await this.service.deleteForMe(messageId, userId);

    if (!result) {
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    }

    // Emit real-time deletion event to the community room. deletedType rides
    // along for forEveryone (mirrors Group's tombstone) — SELF_DELETE/
    // ADMIN_DELETE, now persisted in deletedForAllType by the service.
    const tombstone = buildDeletePayload({
      conversationType: "COMMUNITY",
      messageId: result.id,
      roomId: result.roomId,
      scope: type === "forEveryone" ? "forEveryone" : "forMe",
      deletedBy: userId,
      ...(type === "forEveryone"
        ? {
            deletedType:
              (result as { deletedForAllType?: string }).deletedForAllType ??
              "",
          }
        : {}),
    });
    // delete-for-everyone bumps the room CHANGE revision (delete-for-me is a
    // per-user view state and MUST NOT — §8). Carry revision only in that case.
    const deletedEvent =
      type === "forEveryone"
        ? {
            ...tombstone,
            revision: (result as { revision?: number }).revision ?? 0,
          }
        : tombstone;
    if (result?.roomId) {
      await this.redis.publish(
        `community:${result.roomId}`,
        JSON.stringify({
          event: "community:message:deleted",
          data: deletedEvent,
        })
      );
    }

    // lastActivity recalculation MUST complete (including the synchronous
    // community-service confirmation below) BEFORE the response — mirrors
    // reactToMessage's guaranteed-before-response pattern. Previously this
    // ran fully detached (`void ... .then()`, never awaited by the request
    // handler at all), so a client that re-fetched GET /communities/mine
    // immediately after receiving 200 could race ahead of — or entirely miss
    // — the fire-and-forget, no-DLQ async community.activity.queue publish
    // and see stale lastActivity.

    // When deleted for everyone: recalculate and persist to community-service
    // so the list never shows "Message deleted"/stale preview.
    if (type === "forEveryone" && result.roomId) {
      await this.recalcAndBroadcastLastMessageAfterDelete(
        result.roomId,
        messageId
      );
    }

    // When deleted for me: personalize the deleting user's own view only.
    // Shared snapshot and canonical community-service lastActivity are NOT
    // changed — every other member is unaffected. The self-hide overlay
    // (lastActivityUserId/lastActivitySelfPreview) is the only path that
    // persists this, since the async queue never carries it.
    if (type !== "forEveryone" && result.roomId) {
      try {
        const recalc =
          await this.service.recalculateLastMessageAfterDeleteForMe(
            result.roomId,
            result.createdAt,
            userId
          );
        // Skip unless the deleted message was the viewer's effective last
        // visible message — hiding an older message changes nothing in their list.
        if (recalc !== null && recalc.wasEffectiveLast) {
          await getCommunityReconcileClient().updateMessageActivity({
            communityId: result.roomId,
            selfUserId: userId,
            selfPreview: recalc.preview,
          });
          publishCommunityUpdatedSafe({
            redis: this.redis,
            communityId: result.roomId,
            roomId: result.roomId,
            fetchMembers: () => Promise.resolve([userId]),
            senderId: recalc.sentBy,
            senderName: recalc.senderName,
            lastMessageId: recalc.prevMessageId ?? "",
            lastMessageAt: recalc.hasLastMessage
              ? recalc.createdAt.getTime()
              : Date.now(),
            preview: {
              contentType: normalizeMessageType(recalc.messageType),
              text: recalc.preview,
            },
          });
        }
      } catch (err) {
        logger.warn(
          `deleteMessage|recalculateForMe failed roomId=${result.roomId}: ${String(err)}`
        );
      }
    }

    // When deleted for everyone, check if the message was actively pinned.
    // If so: mark the pin unavailable and emit community:message:pinned update.
    if (type === "forEveryone" && result.roomId) {
      void this.pinService
        .handleMessageDeleted(messageId)
        .then((affectedPin) => {
          if (!affectedPin) return;
          return this.redis.publish(
            `community:${result.roomId}`,
            JSON.stringify({
              event: "community:message:pinned",
              data: {
                communityId: result.roomId,
                roomId: result.roomId,
                pin: {
                  ...affectedPin,
                  originalMessage: { isAvailable: false },
                },
                pinnedCount: null, // unchanged; client uses cached count
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

    res.status(HTTP_STATUS.OK).json(new ApiResponse(tombstone));
  });

  /**
   * Shared by deleteMessage (forEveryone) and unpinMessage/pinMessage (pin
   * system-line retraction): after a message that MAY have been the room's
   * current last message is hard-hidden, recalculate and broadcast the new
   * last message so the community list never keeps showing a preview of a
   * message that's no longer visible. No-op (via `recalc === null`) when the
   * hidden message wasn't actually the last one.
   */
  private async recalcAndBroadcastLastMessageAfterDelete(
    roomId: string,
    deletedMessageId: string
  ): Promise<void> {
    try {
      const recalc = await this.service.recalculateLastMessageAfterDelete(
        roomId,
        deletedMessageId
      );
      if (recalc === null) return;

      if (recalc.hasLastMessage) {
        publishCommunityActivitySafe({
          communityId: roomId,
          lastMessageAt: new Date().toISOString(),
          lastMessageId: recalc.prevMessageId ?? "",
          senderUserId: recalc.sentBy,
          senderUsername: recalc.senderName,
          messagePreview: recalc.preview,
          type: "message",
        });
        // Synchronous companion — awaited before the response, same
        // reasoning as reactToMessage's updateReactionActivity call.
        // Never blocks the delete on failure; the queue publish above
        // remains the backstop.
        await getCommunityReconcileClient().updateMessageActivity({
          communityId: roomId,
          lastMessageAt: Date.now(),
          lastMessageId: recalc.prevMessageId ?? "",
          senderUserId: recalc.sentBy,
          senderUsername: recalc.senderName,
          messagePreview: recalc.preview,
          activityType: "message",
        });
      } else {
        await getCommunityReconcileClient().updateMessageActivity({
          communityId: roomId,
          lastMessageAt: Date.now(),
          lastMessageId: "",
          senderUserId: "",
          senderUsername: "",
          messagePreview: "",
          activityType: "message",
        });
      }
      // Realtime bump — fire-and-forget, the DB write above is already
      // guaranteed by the time this fires.
      publishCommunityUpdatedSafe({
        redis: this.redis,
        communityId: roomId,
        roomId,
        fetchMembers: () => this.service.getActiveMemberIds(roomId),
        // Per-recipient correctness: a member who personally hid the new
        // shared previous-visible message gets THEIR own preview instead.
        resolveOverrides: (memberIds) =>
          this.service
            .resolveForEveryoneOverrides(
              roomId,
              recalc.prevMessageId,
              memberIds
            )
            .then((raw) => renderCommunityOverrides(raw)),
        senderId: recalc.sentBy,
        senderName: recalc.senderName,
        lastMessageId: recalc.prevMessageId ?? "",
        lastMessageAt: recalc.hasLastMessage
          ? recalc.createdAt.getTime()
          : Date.now(),
        preview: {
          contentType: normalizeMessageType(recalc.messageType),
          text: recalc.preview,
        },
      });
    } catch (err) {
      logger.warn(
        `recalcAndBroadcastLastMessageAfterDelete failed roomId=${roomId} messageId=${deletedMessageId}: ${String(err)}`
      );
    }
  }

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

    if (!Number.isFinite(sinceTs) || sinceTs < 0) {
      throw new BadRequestError("CHAT_INVALID_SINCE_TS");
    }

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
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const cursor =
      req.query.cursor != null ? String(req.query.cursor) : undefined;
    if (!query) {
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            { data: [], hasMore: false, nextCursor: null },
            t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale)
          )
        );
      return;
    }
    const result = await this.service.searchMessages({
      roomId,
      userId,
      query,
      limit,
      cursor,
    });
    const data = result.messages.map((m) => ({
      ...m,
      searchScore: result.scores.get((m as { id: string }).id) ?? 0,
    }));
    const msg = data.length
      ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale);
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          { data, hasMore: result.hasMore, nextCursor: result.nextCursor },
          msg
        )
      );
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
    if (!result.idempotent) {
      // Switching pins: publish the existing UNPIN event for the message that
      // got replaced before announcing the new pin.
      if (result.replacedPin) {
        await this.redis.publish(
          `community:${communityId}`,
          JSON.stringify({
            event: "community:message:unpinned",
            data: {
              roomId,
              communityId,
              messageId: result.replacedPin.messageId,
              pin: result.replacedPin,
              pinnedCount: null, // unchanged; the pinned event right after carries the settled count
            },
          })
        );
      }
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
    }
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
          pin: result.pin,
          pinnedCount: result.pinnedCount,
        },
      })
    );
    // The pin's "X pinned a message" system line was already retracted
    // (best-effort, inside pinService.unpin) — if that line happened to be
    // the room's current last message, recalculate lastActivity so the
    // community list doesn't keep showing a preview of a now-removed line.
    if (result.retractedSystemMessageId) {
      await this.recalcAndBroadcastLastMessageAfterDelete(
        roomId,
        result.retractedSystemMessageId
      );
    }
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_MESSAGE_UNPINNED", req.locale)));
  });

  getPins = asyncHandler(async (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const { userId } = req.auth;
    // cursor = "<ms>_<id>" compound format (ISO datetime accepted for backward compat)
    const cursor = req.query.cursor as string | undefined;
    const limit = Number(req.query.limit) || 20;
    const pins = await this.pinService.list(roomId, userId, { limit, cursor });
    const hasMore = pins.length === limit;
    const nextCursor =
      hasMore && pins.length > 0
        ? `${(pins[pins.length - 1]!.pinnedAt as Date).getTime()}_${pins[pins.length - 1]!.id}`
        : null;
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          { data: pins, hasMore, nextCursor },
          t("CHAT_PINS_FETCHED", req.locale)
        )
      );
  });

  /**
   * GET /rooms/:roomId/messages/:messageId/context
   *
   * Returns navigation anchor for a message (e.g. from pin banner tap).
   * FE uses the returned cursor to call GET /rooms/:roomId/messages?around=<messageId>.
   *
   * Response:
   *   200 { messageId, roomId, isAvailable: true, anchor: { beforeCursor, afterCursor } }
   *   200 { messageId, roomId, isAvailable: false, error: { code, message } }
   */
  getMessageContext = asyncHandler(async (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const messageId = req.params.messageId as string;
    const { userId } = req.auth;

    // Require community membership to navigate to a message
    await this.service.assertMember(roomId, userId);

    const message = await this.service.findMessageById(messageId, roomId);
    if (!message || message.deletedForAll) {
      // Message doesn't exist, isn't in this room, or was deleted for everyone.
      res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
          buildUnavailableContext({
            messageId,
            roomId,
            conversationType: "COMMUNITY",
          })
        )
      );
      return;
    }

    res.status(HTTP_STATUS.OK).json(
      new ApiResponse(
        buildAvailableContext({
          messageId,
          roomId,
          conversationType: "COMMUNITY",
          createdAt: message.createdAt,
        })
      )
    );
  });
}
