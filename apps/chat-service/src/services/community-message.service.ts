import { logger } from "@aimess/logger";
import {
  BadRequestError,
  ForbiddenError,
  GoneError,
  NotFoundError,
} from "@aimess/errors";

import {
  CHAT_EDIT_WINDOW_MS,
  CHAT_TEXT_MAX_CHARS,
  assertAttachmentsValid,
} from "../constants/media-limits.js";
import { env } from "../config/env.js";

import type { GeneralRoomMessageRepository } from "../repositories/general-room-message.repository.js";
import type { GeneralRoomRepository } from "../repositories/general-room.repository.js";
import type { RoomMemberRepository } from "../repositories/room-member.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import type { GeneralRoomMessage } from "../generated/prisma/index.js";
import {
  groupStoredReactions,
  normalizeMessageType,
  toWireMessage,
} from "../lib/chat-message.serializer.js";
import { buildMessagePreview } from "../events/publish-message-sent.js";
import { assertCommunityMember } from "../lib/access-guard.js";
import { isDuplicateKeyError } from "../lib/db-errors.js";
import {
  resolveMediaUrlMap,
  urlFromMap,
  applyUrlMapToFiles,
  fileMediaKey,
  type MediaFileLike,
} from "../lib/media-resolve.js";

/**
 * Client-facing community message row: the raw Prisma entity with its
 * LOWER-CASE `messageType` dropped and replaced by an UPPER-CASE `contentType`
 * (§1 single client-facing casing). Used as the return element of every REST
 * read path so HTTP clients never see the internal `messageType` field.
 */
type MemberReadStatus = {
  userId: string;
  lastReadAt: Date | null;
  joinedAt: Date;
};

type CommunityMessageWire = Omit<GeneralRoomMessage, "messageType"> & {
  contentType: string;
  /** Members whose read cursor is at or past this message's createdAt. */
  readBy: Array<{ userId: string; readAt: number }>;
  /** Members who were active in the room when this message was sent. */
  deliveredTo: Array<{ userId: string; deliveredAt: number }>;
};

/** Per-community chat summary for the GET /communities/mine enrichment. */
export interface CommunityChatSummary {
  communityId: string;
  unreadMessageCount: number;
  /** false => the caller should render lastMessageActivity as null. */
  hasLastMessage: boolean;
  lastMessage?: {
    username: string;
    message: string;
    /** epoch ms */
    dateTime: number;
  };
}

/** Denormalized last-message JSON stored on a GeneralRoom. */
interface RoomLastMessageJson {
  content?: string;
  senderId?: string;
  senderName?: string;
  messageType?: string;
  createdAt?: string | Date;
}

export class CommunityMessageService {
  constructor(
    private readonly messageRepo: GeneralRoomMessageRepository,
    private readonly roomRepo: GeneralRoomRepository,
    private readonly memberRepo: RoomMemberRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService
  ) {}

  async sendMessage(params: {
    roomId: string;
    sentBy: string;
    senderName: string;
    senderAvatar: string;
    message: string;
    messageType: string;
    parentMessageId?: string | null;
    clientMessageId?: string | null;
    attachments?: Array<Record<string, unknown>>;
  }): Promise<GeneralRoomMessage> {
    // Defensive caps (the gRPC/socket send path doesn't run the Zod validators).
    if ((params.message?.length ?? 0) > CHAT_TEXT_MAX_CHARS) {
      throw new BadRequestError("CHAT_TEXT_TOO_LONG");
    }
    assertAttachmentsValid(params.messageType, params.attachments);

    // Guard: block sends to suspended or deactivated rooms. "suspended" means
    // the community was closed by an admin; "inactive" means it was deleted.
    // This check runs before idempotency so a suspended-community retry never
    // returns a previously-cached message as if the send succeeded.
    const room = await this.roomRepo.findRoomById(params.roomId);
    if (!room || room.status !== "active") {
      if (room?.status === "suspended") {
        throw new ForbiddenError("COMMUNITY_SUSPENDED");
      }
      throw new ForbiddenError("COMMUNITY_CHAT_DISABLED");
    }

    // Check idempotency
    if (params.clientMessageId) {
      const idemKey = `${params.roomId}:${params.sentBy}:${params.clientMessageId}`;
      const cachedId = await this.cacheRepo.getMessageIdempotency(idemKey);
      if (cachedId) {
        const cached = await this.messageRepo.findById(cachedId);
        if (cached) return cached;
      }
      const existing = await this.messageRepo.findOne({
        roomId: params.roomId,
        sentBy: params.sentBy,
        clientMessageId: params.clientMessageId,
      });
      if (existing) {
        this.cacheRepo
          .setMessageIdempotency(idemKey, existing.id)
          .catch(() => {});
        return existing;
      }
    }

    // Allocate a per-room monotonic sequence number (parity with private/group
    // rooms) so community sync/pagination can use gap-safe keyset cursors. Runs
    // after the idempotency pre-check so replays don't burn numbers; a rare
    // concurrent-race P2002 below may leave a one-number gap (acceptable).
    const sequenceNumber = await this.roomRepo.allocateSequence(params.roomId);

    const entity: Record<string, unknown> = {
      roomId: params.roomId,
      sentBy: params.sentBy,
      senderName: params.senderName,
      senderAvatar: params.senderAvatar,
      message: params.message || "",
      // §1 single casing: store the canonical UPPER-CASE type (matches the
      // private/group services, which both persist via normalizeMessageType).
      // The gRPC send handler already upper-cases contentType, so this is a
      // no-op for live sends but guarantees UPPER for any other caller.
      messageType: normalizeMessageType(params.messageType),
      parentMessageId: params.parentMessageId || null,
      clientMessageId: params.clientMessageId || null,
      sequenceNumber,
    };

    if (params.attachments?.length) {
      entity.attachments = params.attachments;
    }

    // If reply, attach quote data
    if (params.parentMessageId) {
      const originalMsg = await this.messageRepo.findById(
        params.parentMessageId
      );
      if (originalMsg) {
        entity.quoteData = {
          message: originalMsg.message,
          senderName: originalMsg.senderName,
        };
      }
    }

    let message: GeneralRoomMessage;
    try {
      message = await this.messageRepo.save(
        entity as Parameters<typeof this.messageRepo.save>[0]
      );
    } catch (err) {
      // Concurrent send with the same clientMessageId lost the unique-index
      // insert (E11000/P2002 from the sparse idempotency index) — re-read and
      // return the winner so both collapse to one message.
      if (isDuplicateKeyError(err) && params.clientMessageId) {
        const dup = await this.messageRepo.findOne({
          roomId: params.roomId,
          sentBy: params.sentBy,
          clientMessageId: params.clientMessageId,
        });
        if (dup) return dup;
      }
      throw err;
    }

    if (params.clientMessageId) {
      const idemKey = `${params.roomId}:${params.sentBy}:${params.clientMessageId}`;
      this.cacheRepo.setMessageIdempotency(idemKey, message.id).catch(() => {});
    }

    // Update room last message
    this.roomRepo
      .addLastestMessageToRoom(params.roomId, {
        _id: message.id,
        sentBy: message.sentBy,
        senderName: message.senderName || "",
        message: message.message || "",
        messageType: message.messageType,
        createdAt: message.createdAt,
      })
      .catch((err: unknown) => {
        logger.warn(
          `CommunityMessageService|addLastestMessageToRoom failed: ${String(err)}`
        );
      });
    return message;
  }

  /**
   * Offline catch-up: returns missed messages for a community room.
   *
   * Two modes (mutually exclusive — sinceTs takes precedence when both supplied):
   *
   *   sinceTs > 0  — updatedAt-based sweep. Queries via `findUpdatedAtSince`,
   *                  which includes tombstones, edits, and reaction changes.
   *                  Returns `nextTs` (epoch-ms of last event's updatedAt) for
   *                  continued paging.
   *
   *   sinceId      — ObjectId insertion-order query via `findSinceId`.  Includes
   *                  tombstones (deletedForAll=true) so clients can reconcile
   *                  offline deletes.  nextTs is 0 in this mode.
   *
   * Authorizes that the requesting user is an active member before querying.
   */
  async catchup(params: {
    roomId: string;
    userId: string;
    sinceId: string;
    sinceTs?: Date;
    limit: number;
  }): Promise<{
    events: GeneralRoomMessage[];
    hasMore: boolean;
    lastId: string;
    nextTs: number;
    authorized: boolean;
  }> {
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member || member.status !== "active") {
      return {
        events: [],
        hasMore: false,
        lastId: params.sinceId,
        nextTs: 0,
        authorized: false,
      };
    }

    // P2 §13: max 100 events per room per catchup to prevent oversized payloads.
    const limit = Math.min(Math.max(params.limit || 100, 1), 100);

    // since_ts mode: updatedAt-based query that catches all mutation types.
    if (params.sinceTs) {
      const { messages: tsMessages, hasMore } =
        await this.messageRepo.findUpdatedAtSince({
          roomId: params.roomId,
          userId: params.userId,
          fromTs: params.sinceTs,
          limit,
        });
      const lastMsg =
        tsMessages.length > 0 ? tsMessages[tsMessages.length - 1]! : null;
      const lastId = lastMsg?.id ?? params.sinceId;
      const nextTs =
        lastMsg?.updatedAt instanceof Date ? lastMsg.updatedAt.getTime() : 0;
      return {
        events: tsMessages,
        hasMore,
        lastId,
        nextTs,
        authorized: true,
      };
    }

    // since_id mode: ObjectId ordering (insertion-order). Tombstones included.
    const { messages, hasMore } = await this.messageRepo.findSinceId({
      roomId: params.roomId,
      userId: params.userId,
      sinceId: params.sinceId,
      limit,
    });
    const lastId =
      messages.length > 0 ? messages[messages.length - 1]!.id : params.sinceId;
    return { events: messages, hasMore, lastId, nextTs: 0, authorized: true };
  }

  /**
   * Active member userIds for a community room — the recipient list for the
   * community list "bump-to-top" (`community:updated`) fan-out.
   */
  async getActiveMemberIds(roomId: string): Promise<string[]> {
    const members = await this.memberRepo.findActiveByRoom(roomId);
    return members.map((m) => m.userId);
  }

  /**
   * Bulk community-chat summaries for GET /communities/mine. For each requested
   * communityId (roomId === communityId): unread count + last-message preview,
   * but ONLY for communities the user is an ACTIVE member of (member-only
   * previews). Non-member communities get `unreadMessageCount: 0` +
   * `hasLastMessage: false`. Single bulk query per concern — no N+1.
   */
  async getChatSummaries(params: {
    userId: string;
    communityIds: string[];
  }): Promise<CommunityChatSummary[]> {
    const ids = [...new Set(params.communityIds.filter(Boolean))];
    if (!ids.length) return [];

    // 1. Active membership rows → member roomIds + per-room read threshold.
    const members = await this.memberRepo.findActiveByUserAndRooms(
      params.userId,
      ids
    );
    const readMap = new Map<string, Date | null>(
      members.map((m) => [m.roomId, m.lastReadAt])
    );
    const memberRoomIds = members.map((m) => m.roomId);

    // 2/3. In parallel: member rooms (lastMessage JSON) + bulk unread counts.
    const [rooms, unreadMap] = await Promise.all([
      this.roomRepo.findManyByIds(memberRoomIds),
      memberRoomIds.length
        ? this.messageRepo.countUnreadBulk({
            userId: params.userId,
            thresholds: memberRoomIds.map((roomId) => ({
              roomId,
              afterDate: readMap.get(roomId) ?? new Date(0),
            })),
          })
        : Promise.resolve<Record<string, number>>({}),
    ]);
    const roomById = new Map(rooms.map((r) => [r.id, r]));

    // 4. Build a summary for EVERY requested community.
    return ids.map((communityId) => {
      if (!readMap.has(communityId)) {
        // Not an active member → no preview, zero unread (member-only previews).
        return {
          communityId,
          unreadMessageCount: 0,
          hasLastMessage: false,
        };
      }

      const room = roomById.get(communityId);
      const last = (room?.lastMessage ?? null) as RoomLastMessageJson | null;
      const unreadMessageCount = unreadMap[communityId] ?? 0;

      if (!last || !last.createdAt) {
        return { communityId, unreadMessageCount, hasLastMessage: false };
      }

      const createdAt =
        last.createdAt instanceof Date
          ? last.createdAt
          : new Date(last.createdAt);

      return {
        communityId,
        unreadMessageCount,
        hasLastMessage: true,
        lastMessage: {
          username: last.senderName ?? "",
          message: buildMessagePreview(last.messageType ?? "", last.content),
          dateTime: Number.isNaN(createdAt.getTime()) ? 0 : createdAt.getTime(),
        },
      };
    });
  }

  async bulkMarkRead(userId: string, communityIds: string[]): Promise<number> {
    const ids = [...new Set(communityIds.filter(Boolean))];
    if (!ids.length) return 0;
    return this.memberRepo.bulkAdvanceReadToNow(userId, ids);
  }

  /**
   * Map a raw Prisma message to the client wire shape: drop the LOWER-CASE
   * `messageType` and add an UPPER-CASE `contentType` (§1). Every other field
   * (id, roomId, sentBy, senderName, senderAvatar, message, attachments,
   * reactions, deletedForAll, editedAt, createdAt, updatedAt, parentMessageId,
   * …) is preserved unchanged. Applied at the RETURN site of REST read paths
   * only — internal logic continues to read the raw rows.
   */
  /**
   * Collect every stored media key on a page of community rows (sender avatars +
   * attachment object keys) and resolve them ONCE to full download URLs. Pass
   * the returned map to {@link toWire} so each row serializes synchronously and
   * the FE never receives a raw object key.
   */
  private resolveRowsMedia(
    rows: GeneralRoomMessage[]
  ): Promise<Map<string, string>> {
    const keys: string[] = [];
    for (const m of rows) {
      if (m.senderAvatar) keys.push(m.senderAvatar);
      const attachments = m.attachments;
      if (Array.isArray(attachments)) {
        for (const attachment of attachments) {
          const key = fileMediaKey(attachment as MediaFileLike);
          if (key) keys.push(key);
        }
      }
    }
    return resolveMediaUrlMap(keys);
  }

  private toWire(
    m: GeneralRoomMessage,
    members?: MemberReadStatus[],
    urlMap?: Map<string, string>
  ): CommunityMessageWire {
    const wire = toWireMessage(m) as Record<string, unknown>;

    // Resolve raw object keys → full download URLs on read (never persisted, so
    // CDN/presign rotation keeps working). Internal logic still reads raw rows.
    if (urlMap) {
      if (typeof wire.senderAvatar === "string") {
        wire.senderAvatar = urlFromMap(urlMap, wire.senderAvatar);
      }
      if (Array.isArray(wire.attachments)) {
        wire.attachments = applyUrlMapToFiles(
          wire.attachments as MediaFileLike[],
          urlMap
        );
      }
    }

    const msgTs = m.createdAt;

    const readBy = members
      ? members
          .filter((mem) => mem.lastReadAt !== null && mem.lastReadAt >= msgTs)
          .map((mem) => ({
            userId: mem.userId,
            readAt: mem.lastReadAt!.getTime(),
          }))
      : [];

    const deliveredTo = members
      ? members
          .filter((mem) => mem.joinedAt <= msgTs)
          .map((mem) => ({
            userId: mem.userId,
            deliveredAt: msgTs.getTime(),
          }))
      : [];

    return { ...wire, readBy, deliveredTo } as CommunityMessageWire;
  }

  async getMessages(params: {
    roomId: string;
    userId: string;
    cursor?: string | null;
    limit: number;
  }): Promise<CommunityMessageWire[]> {
    await assertCommunityMember(this.memberRepo, params.roomId, params.userId);
    const beforeTimestamp = params.cursor || new Date().toISOString();
    const [rows, members] = await Promise.all([
      this.messageRepo.findByRoomIdWithTime(
        params.roomId,
        beforeTimestamp,
        "older",
        params.limit,
        params.userId
      ),
      this.memberRepo.findReadStatusByRoom(params.roomId),
    ]);
    const urlMap = await this.resolveRowsMedia(rows);
    return rows.map((m) => this.toWire(m, members, urlMap));
  }

  /**
   * Timestamp-keyset page (before_ts / after_ts). Over-fetches one extra row so
   * `hasMore` is exact; `nextCursor` is the boundary createdAt as epoch-ms.
   */
  async getMessagesTimeline(params: {
    roomId: string;
    userId: string;
    direction: "before" | "after";
    ts: Date;
    limit: number;
  }): Promise<{
    items: CommunityMessageWire[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    await assertCommunityMember(this.memberRepo, params.roomId, params.userId);
    const [rows, members] = await Promise.all([
      this.messageRepo.findByRoomIdTimeline({
        roomId: params.roomId,
        userId: params.userId,
        direction: params.direction,
        ts: params.ts,
        limit: params.limit,
      }),
      this.memberRepo.findReadStatusByRoom(params.roomId),
    ]);

    const hasMore = rows.length > params.limit;
    const pageRows = rows.slice(0, params.limit);
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last ? String(last.createdAt.getTime()) : null;

    const urlMap = await this.resolveRowsMedia(pageRows);
    return {
      items: pageRows.map((m) => this.toWire(m, members, urlMap)),
      hasMore,
      nextCursor,
    };
  }

  /**
   * Incremental sync (`after_ts` mode) — returns every message (new, edited,
   * reacted, deleted tombstone) whose `updatedAt >= fromTs`. Designed for
   * offline-first mobile clients catching up after a background period.
   *
   * Key differences from `getMessagesTimeline` (`before_ts` / scroll mode):
   * - Queries by `updatedAt` so edits, reaction changes, and deletes are
   *   included alongside new messages.
   * - Tombstones (`deletedForAll=true`) ARE returned — client reconciles.
   * - Each item carries grouped reactions ready for direct rendering.
   * - `nextCursor` is the epoch-ms `updatedAt` of the last item; the client
   *   stores it and sends it back as the next `after_ts`.
   */
  async getMessagesSince(params: {
    roomId: string;
    userId: string;
    fromTs: Date;
    limit: number;
  }): Promise<{
    items: Array<{
      id: string;
      roomId: string;
      sentBy: string;
      senderName: string | null;
      senderAvatar: string | null;
      message: string | null;
      contentType: string;
      attachments: unknown;
      reactions: Array<{
        emoji: string;
        count: number;
        users: Array<{ userId: string; displayName: string; avatar: string }>;
      }>;
      deletedForAll: boolean;
      editedAt: number | null;
      createdAt: number;
      updatedAt: number;
      syncEventType: "new" | "edited" | "deleted" | "reacted";
    }>;
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    // Enforce active membership — banned/left members cannot read.
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member || member.status !== "active") {
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");
    }

    const { messages, hasMore } = await this.messageRepo.findUpdatedAtSince({
      roomId: params.roomId,
      userId: params.userId,
      fromTs: params.fromTs,
      limit: params.limit,
    });

    const last = messages[messages.length - 1];
    const nextCursor =
      hasMore && last ? String(last.updatedAt.getTime()) : null;

    // Resolve sender avatars, attachment keys, and reaction-user avatars on read
    // so the incremental-sync payload never carries a raw object key.
    const mediaKeys: string[] = [];
    for (const msg of messages) {
      if (msg.senderAvatar) mediaKeys.push(msg.senderAvatar);
      if (Array.isArray(msg.attachments)) {
        for (const attachment of msg.attachments) {
          const key = fileMediaKey(attachment as MediaFileLike);
          if (key) mediaKeys.push(key);
        }
      }
      const reactions = msg.reactions as Record<string, unknown> | null;
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

    const items = messages.map((msg) => {
      const createdMs = msg.createdAt.getTime();
      const updatedMs = msg.updatedAt.getTime();
      const editedMs =
        msg.editedAt instanceof Date ? msg.editedAt.getTime() : null;

      // Derive what kind of mutation this update represents.
      let syncEventType: "new" | "edited" | "deleted" | "reacted";
      if (msg.deletedForAll) {
        syncEventType = "deleted";
      } else if (editedMs !== null) {
        syncEventType = "edited";
      } else if (updatedMs - createdMs > 2000) {
        // updatedAt is more than 2 s after createdAt — something mutated it
        // after creation (most likely a reaction, since edits set editedAt).
        syncEventType = "reacted";
      } else {
        syncEventType = "new";
      }

      return {
        id: msg.id,
        roomId: msg.roomId,
        sentBy: msg.sentBy,
        senderName: msg.senderName ?? null,
        senderAvatar: urlFromMap(urlMap, msg.senderAvatar) || null,
        message: msg.message ?? null,
        contentType: normalizeMessageType(msg.messageType),
        attachments: Array.isArray(msg.attachments)
          ? applyUrlMapToFiles(msg.attachments as MediaFileLike[], urlMap)
          : msg.attachments,
        reactions: groupStoredReactions(msg.reactions).map((group) => ({
          ...group,
          users: group.users.map((user) => ({
            ...user,
            avatar: urlFromMap(urlMap, user.avatar),
          })),
        })),
        deletedForAll: msg.deletedForAll,
        editedAt: editedMs,
        createdAt: createdMs,
        updatedAt: updatedMs,
        syncEventType,
      };
    });

    return { items, hasMore, nextCursor };
  }

  /**
   * Jump-to-message window: resolves the anchor's createdAt, then fetches a
   * window of `limit` messages centered around it.
   */
  async getMessagesAround(params: {
    roomId: string;
    userId: string;
    messageId: string;
    limit: number;
  }): Promise<{ items: CommunityMessageWire[] }> {
    await assertCommunityMember(this.memberRepo, params.roomId, params.userId);
    const anchor = await this.messageRepo.findById(params.messageId);
    if (!anchor) {
      return { items: [] };
    }
    const [rows, members] = await Promise.all([
      this.messageRepo.findAroundDate({
        roomId: params.roomId,
        userId: params.userId,
        anchorDate: anchor.createdAt,
        limit: params.limit,
      }),
      this.memberRepo.findReadStatusByRoom(params.roomId),
    ]);
    const urlMap = await this.resolveRowsMedia(rows);
    return { items: rows.map((m) => this.toWire(m, members, urlMap)) };
  }

  /**
   * Paginated conversation page for a community room + mark-as-read side effect.
   * Enforces active membership first (same check as listMedia), fetches the
   * offset page (createdAt < timestamp, newest first), then advances the
   * caller's read pointer to the newest returned message (forward-only).
   */
  async getConversation(params: {
    roomId: string;
    userId: string;
    pageNumber: number;
    limit: number;
    timestamp?: number;
  }): Promise<{ messages: CommunityMessageWire[]; total: number }> {
    // Enforce active membership first (banned/left members can't read).
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member || member.status !== "active")
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");

    const beforeMs = params.timestamp ?? Date.now();
    const skip = (params.pageNumber - 1) * params.limit;

    const [messages, total] = await Promise.all([
      this.messageRepo.listConversationMessages({
        roomId: params.roomId,
        userId: params.userId,
        beforeMs,
        skip,
        take: params.limit,
      }),
      // Count must match the page's filter (createdAt < beforeMs + per-user
      // deletion exclusion), not the boundary-less countByRoom.
      this.messageRepo.countConversation({
        roomId: params.roomId,
        userId: params.userId,
        beforeMs,
      }),
    ]);

    // Mark-as-read: advance to the newest message in the page (index 0, since
    // the page is createdAt DESC). Forward-only; skip when the page is empty.
    // Runs on the RAW rows (needs id/createdAt) before we map to the wire shape.
    const newest = messages[0];
    if (newest) {
      await this.memberRepo
        .advanceReadPointer(
          params.roomId,
          params.userId,
          newest.id,
          newest.createdAt
        )
        .catch((err: unknown) => {
          logger.warn(
            `CommunityMessageService|getConversation|advanceReadPointer failed: ${String(err)}`
          );
        });
    }

    const urlMap = await this.resolveRowsMedia(messages);
    return {
      messages: messages.map((m) => this.toWire(m, undefined, urlMap)),
      total,
    };
  }

  async searchMessages(params: {
    roomId: string;
    userId: string;
    query: string;
    limit: number;
  }): Promise<CommunityMessageWire[]> {
    await assertCommunityMember(this.memberRepo, params.roomId, params.userId);
    const rows = await this.messageRepo.searchByText(
      params.roomId,
      params.query,
      params.limit,
      params.userId
    );
    const urlMap = await this.resolveRowsMedia(rows);
    return rows.map((m) => this.toWire(m, undefined, urlMap));
  }

  async countMessages(roomId: string): Promise<number> {
    return this.messageRepo.countByRoom(roomId);
  }

  async countSearchResults(roomId: string, query: string): Promise<number> {
    return this.messageRepo.countSearchResults(roomId, query);
  }

  async listMedia(params: {
    roomId: string;
    userId: string;
    type?: string;
    cursor?: string | null;
    limit: number;
  }): Promise<CommunityMessageWire[]> {
    // Enforce active membership first (banned/left members can't list media).
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member || member.status !== "active")
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");

    const rows = await this.messageRepo.listMedia({
      roomId: params.roomId,
      userId: params.userId,
      type: params.type,
      cursor: params.cursor,
      limit: params.limit,
    });
    const urlMap = await this.resolveRowsMedia(rows);
    return rows.map((m) => this.toWire(m, undefined, urlMap));
  }

  async editMessage(params: {
    messageId: string;
    userId: string;
    content: { text: string };
  }): Promise<GeneralRoomMessage> {
    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (message.deletedForAll)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    if (message.sentBy !== params.userId)
      throw new BadRequestError("CHAT_EDIT_OWN_MESSAGES_ONLY");
    // Community messages are persisted with the canonical UPPER-CASE type
    // ("TEXT"), so the guard must compare against UPPER — comparing to the old
    // lower-case "text" rejected every edit (→ SERVICE_ERROR). normalizeMessageType
    // also tolerates any legacy lower-case rows. Mirrors private/group (!== "TEXT").
    if (normalizeMessageType(message.messageType) !== "TEXT")
      throw new BadRequestError("CHAT_EDIT_TEXT_ONLY");
    if ((params.content?.text?.length ?? 0) > CHAT_TEXT_MAX_CHARS)
      throw new BadRequestError("CHAT_TEXT_TOO_LONG");
    if (Date.now() - message.createdAt.getTime() > CHAT_EDIT_WINDOW_MS)
      throw new GoneError("CHAT_EDIT_WINDOW_EXPIRED");
    return this.messageRepo.editMessage(params.messageId, params.content.text);
  }

  async reactToMessage(params: {
    messageId: string;
    userId: string;
    communityId: string;
    emoji: string;
  }): Promise<{
    messageId: string;
    communityId: string;
    reactions: Array<{
      emoji: string;
      count: number;
      users: Array<{ userId: string; displayName: string; avatar: string }>;
    }>;
  }> {
    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (message.deletedForAll)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");

    // Guard: only active members may react.
    const member = await this.memberRepo.findByRoomAndUser(
      message.roomId,
      params.userId
    );
    if (!member || member.status !== "active") {
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");
    }

    // NOTE: non-atomic read-modify-write; acceptable at current scale
    const updatedReactions = (
      message.reactions
        ? {
            ...(message.reactions as Record<
              string,
              Array<{
                userId: string;
                userName: string;
                avatar: string;
                memberId: string;
              }>
            >),
          }
        : {}
    ) as Record<
      string,
      Array<{
        userId: string;
        userName: string;
        avatar: string;
        memberId: string;
      }>
    >;

    if (!updatedReactions[params.emoji]) {
      updatedReactions[params.emoji] = [];
    }

    const existingIndex = updatedReactions[params.emoji]!.findIndex(
      (entry) => entry.userId === params.userId
    );

    if (existingIndex !== -1) {
      updatedReactions[params.emoji]!.splice(existingIndex, 1);
      if (updatedReactions[params.emoji]!.length === 0) {
        delete updatedReactions[params.emoji];
      }
    } else {
      updatedReactions[params.emoji]!.push({
        userId: params.userId,
        userName: "",
        avatar: "",
        memberId: "",
      });
    }

    await this.messageRepo.updateById(
      params.communityId,
      params.messageId,
      updatedReactions
    );

    // Collect all unique userIds across all reaction arrays
    const allUserIds = [
      ...new Set(
        Object.values(updatedReactions)
          .flat()
          .map((e) => e.userId)
          .filter(Boolean)
      ),
    ];

    const snaps =
      allUserIds.length > 0
        ? await this.userSnapshotService.getUserSnapshotsMap(
            allUserIds,
            this.cacheRepo
          )
        : new Map<string, Record<string, unknown>>();

    const reactionGroups = Object.entries(updatedReactions)
      .filter(([, users]) => users.length > 0) // skip defensively if empty
      .map(([emoji, users]) => ({
        emoji,
        count: users.length,
        users: users.map((u) => {
          const snap = snaps.get(u.userId);
          return {
            userId: u.userId,
            displayName: (snap?.displayName as string) || u.userName || "",
            avatar: (snap?.avatar as string) || u.avatar || "",
          };
        }),
      }));

    return {
      messageId: params.messageId,
      communityId: params.communityId,
      reactions: reactionGroups,
    };
  }

  async deleteForMe(
    messageId: string,
    userId: string
  ): Promise<GeneralRoomMessage | null> {
    const message = await this.messageRepo.findById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    await this.messageRepo.deleteForUser(messageId, userId);
    return this.messageRepo.findById(messageId);
  }

  async deleteForAll(
    messageId: string,
    userId: string
  ): Promise<GeneralRoomMessage | null> {
    const message = await this.messageRepo.findById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    // Sender can always delete their own message for everyone.
    // Others need admin or moderator role.
    if (message.sentBy !== userId) {
      const member = await this.memberRepo.findByRoomAndUser(
        message.roomId,
        userId
      );
      if (!member || !["admin", "moderator"].includes(member.role)) {
        throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
      }
    }

    return this.messageRepo.deleteForAll(messageId);
  }

  async report(params: {
    messageId: string;
    reporterId: string;
    reportReason: string;
  }): Promise<GeneralRoomMessage | null> {
    return this.messageRepo.addReport(params.messageId, {
      userReportId: params.reporterId,
      userReportReason: params.reportReason,
    });
  }

  async pinMessage(params: {
    messageId: string;
    userId: string;
    roomId: string;
    communityId: string;
  }): Promise<{ pinnedIds: string[]; pinnedCount: number; pinnedAt: number }> {
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member || member.status !== "active")
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");
    if (!["admin", "moderator"].includes(member.role))
      throw new ForbiddenError("CHAT_INSUFFICIENT_PERMISSIONS");

    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (message.roomId !== params.roomId)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (message.deletedForAll)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");

    const room = await this.roomRepo.findRoomById(params.roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    const pinnedIds: string[] = Array.isArray(room.listPinedMessage)
      ? (room.listPinedMessage as string[])
      : [];

    if (pinnedIds.length >= env.PIN_LIMIT_PER_ROOM)
      throw new BadRequestError("CHAT_PIN_LIMIT_REACHED");

    if (pinnedIds.includes(params.messageId)) {
      return { pinnedIds, pinnedCount: pinnedIds.length, pinnedAt: Date.now() };
    }

    const newPinnedIds = [...pinnedIds, params.messageId];
    await this.roomRepo.updatePinnedMessages(params.roomId, newPinnedIds);
    return {
      pinnedIds: newPinnedIds,
      pinnedCount: newPinnedIds.length,
      pinnedAt: Date.now(),
    };
  }

  async unpinMessage(params: {
    messageId: string;
    userId: string;
    roomId: string;
    communityId: string;
  }): Promise<{ pinnedIds: string[]; pinnedCount: number }> {
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member || member.status !== "active")
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");
    if (!["admin", "moderator"].includes(member.role))
      throw new ForbiddenError("CHAT_INSUFFICIENT_PERMISSIONS");

    const room = await this.roomRepo.findRoomById(params.roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    const pinnedIds: string[] = Array.isArray(room.listPinedMessage)
      ? (room.listPinedMessage as string[])
      : [];

    if (!pinnedIds.includes(params.messageId))
      throw new NotFoundError("CHAT_PIN_NOT_FOUND");

    const newPinnedIds = pinnedIds.filter((id) => id !== params.messageId);
    await this.roomRepo.updatePinnedMessages(params.roomId, newPinnedIds);
    return { pinnedIds: newPinnedIds, pinnedCount: newPinnedIds.length };
  }
}
