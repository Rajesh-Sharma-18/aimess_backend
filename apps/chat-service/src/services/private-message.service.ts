import {
  BadRequestError,
  ForbiddenError,
  GoneError,
  NotFoundError,
} from "@aimess/errors";
import { logger } from "@aimess/logger";

import {
  CHAT_EDIT_WINDOW_MS,
  CHAT_TEXT_MAX_CHARS,
  assertAttachmentsValid,
} from "../constants/media-limits.js";
import { publishAdminReportIngestSafe } from "../events/publish-admin-report.js";
import {
  normalizeMessageType,
  buildCanonicalQuote,
  buildReactionGroups,
  reactionUserIdMap,
  toggleStoredReaction,
  toWireMessage,
} from "../lib/chat-message.serializer.js";
import { assertPrivateParticipant } from "../lib/access-guard.js";
import { isDuplicateKeyError } from "../lib/db-errors.js";
import { markIdempotentReplay } from "../lib/idempotency.js";
import {
  resolveForEveryoneOverrides,
  deletedWasEffectiveLast,
  type RecipientOverride,
} from "./last-visible-resolver.js";
import { privateVisibilitySource } from "./last-visible-adapters.js";
import {
  resolveMediaUrlMap,
  urlFromMap,
  applyUrlMapToFiles,
  fileMediaKey,
  type MediaFileLike,
} from "../lib/media-resolve.js";

import type { PrivateMessageRepository } from "../repositories/private-message.repository.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { PrivateMessageReportRepository } from "../repositories/private-message-report.repository.js";
import type { UserServiceClient } from "../grpc/user.client.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import type {
  PrivateMessage,
  PrivateMessageReport,
} from "../generated/prisma/index.js";

export class PrivateMessageService {
  constructor(
    private readonly messageRepo: PrivateMessageRepository,
    private readonly roomRepo: PrivateRoomRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService,
    private readonly userServiceClient: UserServiceClient,
    private readonly reportRepo: PrivateMessageReportRepository
  ) {}

  async sendMessage(params: {
    roomId: string;
    senderId: string;
    receiverId: string;
    content: {
      text: string;
      urls?: string[];
      files?: Array<Record<string, unknown>>;
    };
    messageType: string;
    parentMessageId?: string | null;
    clientMessageId?: string | null;
    /** Client compose time (epoch ms) — display only; never overwrites serverTs. */
    clientTs?: number | null;
  }): Promise<PrivateMessage> {
    // Defensive caps (the gRPC/socket send path doesn't run the Zod validators).
    if ((params.content?.text?.length ?? 0) > CHAT_TEXT_MAX_CHARS) {
      throw new BadRequestError("CHAT_TEXT_TOO_LONG");
    }
    assertAttachmentsValid(params.messageType, params.content?.files);

    const friends = await this.userServiceClient.checkFriendship(
      params.senderId,
      params.receiverId
    );
    if (!friends) {
      throw new ForbiddenError("CHAT_FRIENDSHIP_REQUIRED");
    }

    // Idempotency: if clientMessageId provided, check for existing message
    if (params.clientMessageId) {
      const existing = await this.messageRepo.findByClientMessageId(
        params.roomId,
        params.senderId,
        params.clientMessageId
      );
      if (existing) return markIdempotentReplay(existing);
    }

    const entity: Record<string, unknown> = {
      roomId: params.roomId,
      senderId: params.senderId,
      receiverId: params.receiverId,
      content: params.content,
      messageType: normalizeMessageType(params.messageType),
      parentMessageId: params.parentMessageId || null,
      clientMessageId: params.clientMessageId ?? null,
      // §5.1: persist the client compose time alongside (never instead of) the
      // server createdAt, so the client can show its original send time offline.
      ...(params.clientTs ? { clientInfo: { clientTs: params.clientTs } } : {}),
    };

    // If reply, attach the canonical quote snapshot (§1/§9):
    // { messageId, senderId, senderName, messageType, preview, isDeleted }.
    if (params.parentMessageId) {
      const originalMsg = await this.messageRepo.findById(
        params.parentMessageId
      );
      if (originalMsg) {
        const originSenderId = originalMsg.senderId || "";
        const snapshots = await this.userSnapshotService.getUserSnapshotsMap(
          [originSenderId],
          this.cacheRepo
        );
        const senderSnap =
          (snapshots.get(originSenderId) as Record<string, unknown>) || {};
        entity.quoteData = {
          messageId: originalMsg.id,
          senderId: originSenderId,
          senderName:
            (senderSnap.displayName as string) ||
            (senderSnap.memberId as string) ||
            "",
          messageType: normalizeMessageType(originalMsg.messageType),
          preview:
            ((originalMsg.content as Record<string, unknown> | null)
              ?.text as string) || "",
          isDeleted: Boolean(originalMsg.isDeleted),
        };
      }
    }

    // Allocate the per-room monotonic sequence AFTER the idempotency pre-check,
    // immediately before insert, so a retried clientMessageId never burns a seq.
    // On the duplicate-key path below the allocated seq is discarded (an
    // acceptable per-room gap — we do not retry allocation).
    const seq = await this.roomRepo.allocateSequence(params.roomId);
    entity.sequenceNumber = seq;

    let message: PrivateMessage;
    try {
      message = await this.messageRepo.createMessage(
        entity as Parameters<PrivateMessageRepository["createMessage"]>[0]
      );
    } catch (err) {
      // Concurrent send with the same clientMessageId: the pre-send dedup check
      // above raced with a sibling request, both saw "not found", and both
      // reached the insert. The partial-unique idempotency index
      // (roomId, senderId, clientMessageId) rejects the loser with E11000/P2002.
      // Re-read and return the winner so all concurrent sends collapse to one
      // message instead of surfacing a 500 / SERVICE_ERROR.
      if (params.clientMessageId && isDuplicateKeyError(err)) {
        const dup = await this.messageRepo.findByClientMessageId(
          params.roomId,
          params.senderId,
          params.clientMessageId
        );
        if (dup) return markIdempotentReplay(dup);
      }
      throw err;
    }

    // Update room with last message
    this.roomRepo
      .updateRoomOnNewMessage({
        roomId: params.roomId,
        message: {
          _id: message.id,
          content: message.content,
          senderId: message.senderId || "",
          messageType: message.messageType,
          systemEvent: message.systemEvent,
          systemData: message.systemData,
          createdAt: message.createdAt,
        },
        receiverId: params.receiverId,
      })
      .catch((err: unknown) => {
        logger.warn(`PrivateMessageService|updateRoom failed: ${String(err)}`);
      });
    return message;
  }

  async getMessages(params: {
    roomId: string;
    userId: string;
    cursor?: string | null;
    limit: number;
  }): Promise<PrivateMessage[]> {
    const room = await assertPrivateParticipant(
      this.roomRepo,
      params.roomId,
      params.userId
    );

    const beforeTimestamp = params.cursor || new Date().toISOString();
    return this.messageRepo.findByRoomIdWithTime(
      params.userId,
      { roomId: room.roomId },
      beforeTimestamp,
      params.limit
    );
  }

  /**
   * Timestamp-paginated message page (before_ts / after_ts). Over-fetches one
   * extra row in the repo so `hasMore` is exact; `nextCursor` is the boundary
   * message's createdAt as epoch-ms (feed back as the next before_ts/after_ts).
   */
  async getMessagesTimeline(params: {
    roomId: string;
    userId: string;
    direction: "before" | "after";
    ts: Date;
    /** Keyset tiebreaker parsed from a compound before_ts/after_ts ("<ms>_<id>"). */
    boundaryId?: string | null;
    /** True for the first page (no cursor) so the boundary message is included. */
    inclusive?: boolean;
    limit: number;
  }): Promise<{
    items: PrivateMessage[];
    hasMore: boolean;
    nextCursor: string | null;
    total: number;
  }> {
    const room = await assertPrivateParticipant(
      this.roomRepo,
      params.roomId,
      params.userId
    );

    const [{ messages: items, hasMore }, total] = await Promise.all([
      this.messageRepo.findByRoomIdTimeline({
        userId: params.userId,
        roomId: room.roomId,
        direction: params.direction,
        ts: params.ts,
        boundaryId: params.boundaryId ?? null,
        inclusive: params.inclusive ?? false,
        limit: params.limit,
      }),
      this.messageRepo.countTimeline({
        roomId: room.roomId,
        userId: params.userId,
      }),
    ]);

    // The repo returns the page in DB order (before → newest-first, after →
    // oldest-first); the boundary for the next page is the LAST row either way.
    // nextCursor is a COMPOUND "<createdAtMs>_<id>" keyset cursor — the _id
    // tiebreaker is what keeps same-millisecond messages reachable. The client
    // feeds it back verbatim as the next before_ts/after_ts.
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last ? `${last.createdAt.getTime()}_${last.id}` : null;

    return { items, hasMore, nextCursor, total };
  }

  /**
   * V2 §3.2: seq-keyset page. `nextCursor` is the boundary `sequenceNumber`
   * (feed back as before_seq when paging older, after_seq when paging newer).
   */
  async getMessagesSeq(params: {
    roomId: string;
    userId: string;
    direction: "before" | "after";
    seq: number;
    limit: number;
  }): Promise<{
    items: PrivateMessage[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const room = await assertPrivateParticipant(
      this.roomRepo,
      params.roomId,
      params.userId
    );

    const rows = await this.messageRepo.findByRoomIdSeq({
      userId: params.userId,
      roomId: room.roomId,
      direction: params.direction,
      seq: params.seq,
      limit: params.limit,
    });
    const hasMore = rows.length > params.limit;
    const items = rows.slice(0, params.limit);
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? String(last.sequenceNumber) : null;
    return { items, hasMore, nextCursor };
  }

  /**
   * V2 §3.2: jump-to-message window centered on a message id (reply-tap, search
   * navigation). Resolves the anchor's sequenceNumber, then fetches the window.
   */
  async getMessagesAround(params: {
    roomId: string;
    userId: string;
    messageId: string;
    limit: number;
  }): Promise<{ items: PrivateMessage[]; anchorSeq: number }> {
    const room = await assertPrivateParticipant(
      this.roomRepo,
      params.roomId,
      params.userId
    );
    const anchor = await this.messageRepo.findById(params.messageId);
    if (!anchor) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    const items = await this.messageRepo.findAroundSeq({
      userId: params.userId,
      roomId: room.roomId,
      anchorSeq: anchor.sequenceNumber,
      limit: params.limit,
    });
    return { items, anchorSeq: anchor.sequenceNumber };
  }

  async searchMessages(params: {
    roomId: string;
    userId: string;
    query: string;
    limit: number;
  }): Promise<PrivateMessage[]> {
    await assertPrivateParticipant(this.roomRepo, params.roomId, params.userId);
    return this.messageRepo.searchByText(
      params.roomId,
      params.query,
      params.limit
    );
  }

  async listMedia(params: {
    roomId: string;
    userId: string;
    type?: string;
    cursor?: string | null;
    limit: number;
  }): Promise<PrivateMessage[]> {
    // Enforce participation first.
    const room = await this.roomRepo.findByRoomId(params.roomId, {
      projection: { roomId: 1, participants: 1 },
    });
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    if (!room.participants?.includes(params.userId))
      throw new ForbiddenError("CHAT_NOT_PARTICIPANT");

    return this.messageRepo.listMedia({
      roomId: room.roomId,
      userId: params.userId,
      type: params.type,
      cursor: params.cursor,
      limit: params.limit,
    });
  }

  async markRead(params: {
    roomId: string;
    userId: string;
    lastMessageId: string;
  }): Promise<unknown> {
    return this.roomRepo.markReadUpTo({
      roomId: params.roomId,
      userId: params.userId,
      upToMessageId: params.lastMessageId,
    });
  }

  /**
   * Resolve a message's per-room `sequenceNumber` from its id (O(1) indexed PK
   * lookup). Used by the read_sync fan-out to publish a `read_to_seq` high-water
   * mark to the reader's other devices. Returns 0 if the message is missing.
   */
  async getMessageSequence(messageId: string): Promise<number> {
    if (!messageId) return 0;
    const msg = await this.messageRepo.findById(messageId);
    const seq = (msg as { sequenceNumber?: number } | null)?.sequenceNumber;
    return typeof seq === "number" ? seq : 0;
  }

  async deleteForMe(
    messageId: string,
    userId: string
  ): Promise<PrivateMessage> {
    const message = await this.messageRepo.findById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    // The route carries no roomId. Derive the room from the message and authorize
    // the caller as a participant of THAT room BEFORE any mutation — otherwise any
    // authed user could delete-for-me a message in a DM they're not in (IDOR).
    await this.assertCallerInMessageRoom(message, userId);
    // isDeleted=true means already deleted for everyone — can't delete for me again
    if (message.isDeleted)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    // Check if this user already deleted it for themselves
    const deletedFor = (message.deletedFor ?? {}) as Record<string, unknown>;
    if (userId in deletedFor)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    return this.messageRepo.deleteForMe(messageId, userId);
  }

  /**
   * After a delete-for-everyone, if the deleted message was the room's current
   * last message, finds the previous visible message and updates the room preview.
   * Returns data for the conv:updated broadcast, or null when the deleted message
   * was not the last (no-op).
   */
  async recalculateLastMessageAfterDelete(
    roomId: string,
    deletedMessageId: string
  ): Promise<{
    prevMessageId: string | null;
    messageType: string;
    content: unknown;
    senderId: string;
    createdAt: Date;
    hasLastMessage: boolean;
  } | null> {
    const [room, prev] = await Promise.all([
      this.roomRepo.findByRoomId(roomId),
      this.messageRepo.findPreviousVisible(roomId),
    ]);
    if (!room) return null;
    if (
      room.lastMessageId !== deletedMessageId &&
      room.lastMessageId === (prev?.id ?? null)
    ) {
      return null;
    }
    if (prev) {
      await this.roomRepo.setLastMessage(roomId, {
        id: prev.id,
        senderId: prev.senderId ?? "",
        content: prev.content,
        messageType: prev.messageType,
        createdAt: prev.createdAt,
      });
      return {
        prevMessageId: prev.id,
        messageType: prev.messageType,
        content: prev.content,
        senderId: prev.senderId ?? "",
        createdAt: prev.createdAt,
        hasLastMessage: true,
      };
    }

    await this.roomRepo.setLastMessage(roomId, null);
    return {
      prevMessageId: null,
      messageType: "",
      content: null,
      senderId: "",
      createdAt: new Date(0),
      hasLastMessage: false,
    };
  }

  /**
   * After a delete-for-me on the last message, finds the previous message
   * visible to that specific user (skipping both globally-deleted and
   * personally-deleted messages). Returns data for a targeted conv:updated
   * broadcast to that user only, or null when the deleted message was not the
   * room's current last (no-op).
   * Does NOT update the shared room snapshot — the other participant's view is
   * unchanged.
   */
  /**
   * Per-recipient list-preview overrides for a delete-for-everyone fan-out: the
   * participant who has personally hidden `sharedPrevMessageId` gets their own
   * visible preview instead of the shared one. Empty map in the common case.
   */
  async resolveForEveryoneOverrides(
    roomId: string,
    sharedPrevMessageId: string | null,
    recipientIds: string[]
  ): Promise<Map<string, RecipientOverride | null>> {
    return resolveForEveryoneOverrides(
      privateVisibilitySource(this.messageRepo),
      roomId,
      sharedPrevMessageId,
      recipientIds
    );
  }

  async recalculateLastMessageAfterDeleteForMe(
    roomId: string,
    deletedMessageCreatedAt: Date,
    userId: string
  ): Promise<{
    prevMessageId: string | null;
    messageType: string;
    content: unknown;
    senderId: string;
    createdAt: Date;
    hasLastMessage: boolean;
    /** True iff the deleted message was the viewer's last visible message — the
     *  ONLY case where a targeted list bump is warranted (else it is a no-op). */
    wasEffectiveLast: boolean;
  } | null> {
    const room = await this.roomRepo.findByRoomId(roomId);
    if (!room) return null;
    // No early-return on lastMessageId check: the deleted message may not be
    // the globally-last but could still be the user's effective last visible.
    const prev = await this.messageRepo.findPreviousVisibleForUser(
      roomId,
      userId
    );
    // The deleted (now-hidden) message was the viewer's last iff nothing still
    // visible is newer than it (single source of truth: deletedWasEffectiveLast).
    const wasEffectiveLast = deletedWasEffectiveLast(
      prev?.createdAt ?? null,
      deletedMessageCreatedAt
    );
    if (prev) {
      return {
        prevMessageId: prev.id,
        messageType: prev.messageType,
        content: prev.content,
        senderId: prev.senderId ?? "",
        createdAt: prev.createdAt,
        hasLastMessage: true,
        wasEffectiveLast,
      };
    }
    return {
      prevMessageId: null,
      messageType: "",
      content: null,
      senderId: "",
      createdAt: new Date(0),
      hasLastMessage: false,
      wasEffectiveLast: true,
    };
  }

  async deleteForEveryone(
    messageId: string,
    userId: string
  ): Promise<PrivateMessage> {
    const message = await this.messageRepo.findById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    // Bind message↔room BEFORE the sender check: a user not in (or removed from)
    // the room can't mutate even their own old message. NotFound so existence
    // isn't leaked; keeps the room-bind uniform across all private writes.
    await this.assertCallerInMessageRoom(message, userId);
    if (message.isDeleted)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    if (message.senderId !== userId) {
      throw new BadRequestError("CHAT_DELETE_OWN_MESSAGES_ONLY");
    }
    return this.messageRepo.deleteForEveryone(messageId, userId);
  }

  async editMessage(params: {
    messageId: string;
    userId: string;
    content: {
      text: string;
      urls?: string[];
      files?: Array<Record<string, unknown>>;
    };
  }): Promise<PrivateMessage> {
    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    // Bind message↔room BEFORE the sender check: a user not in (or removed from)
    // the room can't mutate even their own old message. NotFound so existence
    // isn't leaked; keeps the room-bind uniform across all private writes.
    await this.assertCallerInMessageRoom(message, params.userId);
    if (message.isDeleted)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    if (message.senderId !== params.userId)
      throw new BadRequestError("CHAT_EDIT_OWN_MESSAGES_ONLY");
    if (message.messageType !== "TEXT")
      throw new BadRequestError("CHAT_EDIT_TEXT_ONLY");
    if ((params.content?.text?.length ?? 0) > CHAT_TEXT_MAX_CHARS)
      throw new BadRequestError("CHAT_TEXT_TOO_LONG");
    if (Date.now() - message.createdAt.getTime() > CHAT_EDIT_WINDOW_MS)
      throw new GoneError("CHAT_EDIT_WINDOW_EXPIRED");
    return this.messageRepo.editMessage(params.messageId, params.content);
  }

  async markDelivered(params: {
    roomId: string;
    recipientId: string;
    upToMessageId: string;
  }): Promise<{ count: number; messageIds: string[] }> {
    return this.messageRepo.markDeliveredUpTo(
      params.roomId,
      params.recipientId,
      params.upToMessageId
    );
  }

  async reportMessage(params: {
    messageId: string;
    reporterId: string;
    reason: string;
    description?: string;
  }): Promise<PrivateMessageReport> {
    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    const room = await this.roomRepo.findByRoomId(message.roomId);
    if (!room || !room.participants?.includes(params.reporterId))
      throw new ForbiddenError("CHAT_REPORT_NOT_PARTICIPANT");

    if (message.senderId === params.reporterId)
      throw new BadRequestError("CHAT_REPORT_OWN_MESSAGE");

    try {
      const report = await this.reportRepo.create({
        roomId: message.roomId,
        messageId: message.id,
        reporterId: params.reporterId,
        reportedUserId: message.senderId ?? "",
        reason: params.reason,
        description: params.description ?? "",
      });
      publishAdminReportIngestSafe({
        type: "user",
        targetId: message.senderId ?? "",
        reporterId: params.reporterId,
        reason: params.reason,
        details: params.description?.trim() ? params.description.trim() : null,
        eventAt: new Date().toISOString(),
        sourceReportId: report.id,
      });
      return report;
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "P2002"
      ) {
        throw new BadRequestError("CHAT_ALREADY_REPORTED");
      }
      throw err;
    }
  }

  /**
   * Toggle a single user's emoji reaction on a private message. Reads the stored
   * reactor map, flips `userId`'s membership in the `emoji` bucket (add on first
   * react, remove on a duplicate react = toggle-off), and persists the canonical
   * `{ emoji: [{ userId, userName, avatar, memberId }] }` shape. Other emojis are
   * preserved.
   */
  async react(
    messageId: string,
    userId: string,
    emoji: string
  ): Promise<PrivateMessage | null> {
    const raw = await this.messageRepo.getReactions(messageId);
    if (raw === null) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    const updated = toggleStoredReaction(raw, userId, emoji);
    return this.messageRepo.addReactions(messageId, updated);
  }

  /**
   * Authorize a REST react/remove-reaction: the caller MUST be a participant of
   * the private room. The shared `react()` primitive deliberately does NOT guard
   * (the socket/gRPC path is pre-authorized by room membership at join), so the
   * REST boundary enforces participation here — the same rule the read paths use.
   */
  async assertParticipant(roomId: string, userId: string): Promise<void> {
    await assertPrivateParticipant(this.roomRepo, roomId, userId);
  }

  /**
   * Bind a message to its room: throw CHAT_MESSAGE_NOT_FOUND unless `messageId`
   * actually belongs to `roomId`. The `react()` primitive mutates a message by id
   * ALONE, so a REST caller authorized for room A could otherwise pass a messageId
   * from room B (a DM they're not in) and mutate/broadcast that foreign message.
   * Querying by BOTH id + roomId (same `findMessageMeta` the pin path uses) closes
   * that cross-room IDOR; call this AFTER the participant guard, BEFORE react().
   */
  async assertMessageInRoom(roomId: string, messageId: string): Promise<void> {
    const msg = await this.messageRepo.findMessageMeta({ roomId, messageId });
    if (!msg) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
  }

  /** Bind a loaded message to a room the caller participates in (cross-room IDOR
   * guard for routes that carry no roomId). NotFound — never Forbidden — so a
   * foreign message's existence isn't leaked. */
  private async assertCallerInMessageRoom(
    message: PrivateMessage,
    userId: string
  ): Promise<void> {
    const room = await this.roomRepo.findByRoomId(message.roomId, {
      projection: { roomId: 1, participants: 1 },
    });
    if (!room?.participants?.includes(userId))
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
  }

  async countMessages(roomId: string): Promise<number> {
    return this.messageRepo.countByRoom(roomId);
  }

  async countSearchResults(roomId: string, query: string): Promise<number> {
    return this.messageRepo.countSearchResults(roomId, query);
  }

  async forwardMessage(params: {
    sourceMessageId: string;
    /** SOURCE room the message is being forwarded FROM (REST path param). When
     * provided, it must MATCH the message's actual room (cross-check). Null on the
     * gRPC path. Either way the caller must be a participant of the message's
     * ACTUAL room — that bind is unconditional and closes the forward read-IDOR. */
    sourceRoomId?: string | null;
    targetRoomId: string;
    senderId: string;
    receiverId: string;
    clientMessageId?: string | null;
  }): Promise<PrivateMessage> {
    // friendship gate
    const friends = await this.userServiceClient.checkFriendship(
      params.senderId,
      params.receiverId
    );
    if (!friends) throw new ForbiddenError("CHAT_FRIENDSHIP_REQUIRED");

    // idempotency
    if (params.clientMessageId) {
      const existing = await this.messageRepo.findByClientMessageId(
        params.targetRoomId,
        params.senderId,
        params.clientMessageId
      );
      if (existing) return markIdempotentReplay(existing);
    }

    // fetch source message
    const source = await this.messageRepo.findById(params.sourceMessageId);
    if (!source || source.isDeleted)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    // If the caller asserted a source room (REST path param), it must match the message's room.
    if (params.sourceRoomId != null && source.roomId !== params.sourceRoomId)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    // The caller MUST belong to the message's ACTUAL room — on BOTH transports. Forwarding
    // READS source.content, so without this a socket caller (gRPC carries no sourceRoomId)
    // could exfiltrate any message from a DM they're not in. Closes the cross-room read-IDOR.
    await this.assertCallerInMessageRoom(source, params.senderId);

    const forwardData = {
      originalMessageId: source.id,
      originalRoomId: source.roomId,
      originalSenderId: source.senderId ?? "",
      originalCreatedAt: source.createdAt.toISOString(),
      originalContentType: source.messageType,
    };

    const seq = await this.roomRepo.allocateSequence(params.targetRoomId);

    let message: PrivateMessage;
    try {
      message = await this.messageRepo.createForwardedMessage({
        roomId: params.targetRoomId,
        senderId: params.senderId,
        receiverId: params.receiverId,
        content: source.content as object,
        messageType: source.messageType,
        forwardData,
        clientMessageId: params.clientMessageId ?? null,
        sequenceNumber: seq,
      });
    } catch (err) {
      // Same idempotency race as sendMessage: a concurrent forward with the
      // same clientMessageId loses the unique-index insert (E11000/P2002) —
      // re-read and return the winner instead of erroring.
      if (params.clientMessageId && isDuplicateKeyError(err)) {
        const dup = await this.messageRepo.findByClientMessageId(
          params.targetRoomId,
          params.senderId,
          params.clientMessageId
        );
        if (dup) return markIdempotentReplay(dup);
      }
      throw err;
    }

    this.roomRepo
      .updateRoomOnNewMessage({
        roomId: params.targetRoomId,
        message: {
          _id: message.id,
          content: message.content,
          senderId: message.senderId ?? "",
          messageType: message.messageType,
          systemEvent: message.systemEvent,
          systemData: message.systemData,
          createdAt: message.createdAt,
        },
        receiverId: params.receiverId,
      })
      .catch((err: unknown) => {
        logger.warn(
          `PrivateMessageService|forwardMessage|updateRoom failed: ${String(err)}`
        );
      });

    return message;
  }

  async getMessageReactions(params: {
    messageId: string;
    roomId: string;
    requesterId: string;
  }): Promise<{
    reactions: Record<
      string,
      {
        count: number;
        users: { userId: string; displayName: string; avatar: string }[];
        selfReacted: boolean;
      }
    >;
  }> {
    const raw = await this.messageRepo.getReactions(params.messageId);
    if (raw === null) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    // Stored entries are reactor OBJECTS; reduce to { emoji: userId[] } so the
    // grouped result carries the plain id string in users[].userId (not the object).
    const reactions = reactionUserIdMap(raw);
    const allUserIds = [...new Set(Object.values(reactions).flat())];

    const snapshots =
      allUserIds.length > 0
        ? await this.userSnapshotService.getUserSnapshotsMap(
            allUserIds,
            this.cacheRepo
          )
        : new Map<string, Record<string, unknown>>();

    const result: Record<
      string,
      {
        count: number;
        users: { userId: string; displayName: string; avatar: string }[];
        selfReacted: boolean;
      }
    > = {};

    for (const [emoji, userIds] of Object.entries(reactions)) {
      result[emoji] = {
        count: userIds.length,
        selfReacted: userIds.includes(params.requesterId),
        users: userIds.map((uid) => {
          const snap = snapshots.get(uid) ?? {};
          return {
            userId: uid,
            displayName:
              (snap.displayName as string) ?? (snap.memberId as string) ?? "",
            avatar: (snap.avatar as string) ?? "",
          };
        }),
      };
    }

    return { reactions: result };
  }

  /**
   * Reconnect gap-fill: returns messages with sequenceNumber > sinceSeq for a
   * room the user participates in. Includes tombstones (no isDeleted filter) so
   * the client can reconcile deletes/edits it missed while offline.
   */
  async catchup(p: {
    roomId: string;
    userId: string;
    sinceSeq: number;
    limit: number;
  }): Promise<{
    authorized: boolean;
    events: PrivateMessage[];
    hasMore: boolean;
    lastSeq: number;
  }> {
    const room = await this.roomRepo.findByRoomId(p.roomId, {
      projection: { roomId: 1, participants: 1 },
    });
    if (!room || !room.participants?.includes(p.userId)) {
      return {
        authorized: false,
        events: [],
        hasMore: false,
        lastSeq: p.sinceSeq,
      };
    }

    const rows = await this.messageRepo.findAfterSeq(
      p.roomId,
      p.sinceSeq,
      p.limit
    );
    const hasMore = rows.length > p.limit;
    const rawEvents = hasMore ? rows.slice(0, p.limit) : rows;

    // Exclude messages the requesting user hid with "delete for me".
    // deletedFor shape: { [userId]: ISO-timestamp }
    const events = rawEvents.filter((m) => {
      const deletedFor = (m.deletedFor ?? {}) as Record<string, unknown>;
      return !(p.userId in deletedFor);
    });

    const lastSeq = events.length
      ? events[events.length - 1]!.sequenceNumber
      : p.sinceSeq;

    return { authorized: true, events, hasMore, lastSeq };
  }

  async enrichMessages(
    messages: PrivateMessage[]
  ): Promise<Array<Record<string, unknown>>> {
    const senderIds = [
      ...new Set(
        messages.map((m) => m.senderId).filter((s): s is string => Boolean(s))
      ),
    ];

    const snapshots = senderIds.length
      ? await this.userSnapshotService.getUserSnapshotsMap(
          senderIds,
          this.cacheRepo
        )
      : new Map<string, Record<string, unknown>>();

    // Resolve every stored media key on this page ONCE (sender + reaction-user
    // avatars + attachment object keys) into full download URLs. Resolve on
    // READ — persisted snapshots keep the stable raw object key; the
    // presigned/CDN URL is (re)derived here so the FE never receives a key.
    const mediaKeys: string[] = [];
    for (const snap of snapshots.values()) {
      const avatar = (snap as Record<string, unknown>).avatar;
      if (typeof avatar === "string" && avatar) mediaKeys.push(avatar);
    }
    for (const message of messages) {
      const files = (message.content as Record<string, unknown> | null)?.files;
      if (Array.isArray(files)) {
        for (const file of files) {
          const key = fileMediaKey(file as MediaFileLike);
          if (key) mediaKeys.push(key);
        }
      }
      const reactions = message.reactions as Record<string, unknown> | null;
      if (reactions) {
        for (const reactors of Object.values(reactions)) {
          if (!Array.isArray(reactors)) continue;
          for (const reactor of reactors) {
            const avatar = (reactor as Record<string, unknown>)?.avatar;
            if (typeof avatar === "string" && avatar) mediaKeys.push(avatar);
          }
        }
      }
    }
    const urlMap = await resolveMediaUrlMap(mediaKeys);

    return messages.map((message) => {
      const snapshot = (snapshots.get(message.senderId || "") || {}) as Record<
        string,
        unknown
      >;
      // §1: canonical wire shape — drops the internal `messageType` column and
      // exposes UPPER-CASE `contentType`, identical to the socket message:new
      // and the REST edit/forward responses (single client mapper).
      const wire = toWireMessage(
        message as { messageType?: string | null }
      ) as unknown as Record<string, unknown>;
      const displayName = (snapshot.displayName as string) || "";
      const avatar = urlFromMap(urlMap, (snapshot.avatar as string) || "");

      // Stamp resolved download URLs onto attachment files (content.files[]).
      const content = wire.content as Record<string, unknown> | null;
      const resolvedContent =
        content && Array.isArray(content.files)
          ? {
              ...content,
              files: applyUrlMapToFiles(
                content.files as MediaFileLike[],
                urlMap
              ),
            }
          : content;

      // Canonical client-facing reaction shape (FE reads `reactionGroups[]`; the
      // legacy `reactions` map carried by `...wire` is deprecated).
      const reactionGroups = buildReactionGroups(wire.reactions, (key) =>
        urlFromMap(urlMap, key)
      );

      return {
        ...wire,
        content: resolvedContent,
        senderDisplayName: displayName,
        senderAvatar: avatar,
        senderMemberId: (snapshot.memberId as string) || "",
        isDeletedUser: snapshot.isDeletedUser === true,
        // additive canonical aliases so REST history reads with the SAME mapper
        // as the socket message:new (legacy fields kept untouched).
        senderName: displayName,
        conversationType: "PRIVATE",
        quoteData: buildCanonicalQuote(wire.quoteData),
        reactionGroups,
        clientTs: Number(
          (wire.clientInfo as Record<string, unknown> | null)?.clientTs ?? 0
        ),
        serverTs:
          message.createdAt instanceof Date ? message.createdAt.getTime() : 0,
      };
    });
  }
}
