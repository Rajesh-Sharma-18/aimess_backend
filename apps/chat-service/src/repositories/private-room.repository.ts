import type {
  PrismaClient,
  PrivateRoom,
  Prisma,
} from "../generated/prisma/index.js";
import { withWriteConflictRetry } from "../lib/db-errors.js";
import { buildRoomKeysetWhere } from "../lib/pagination.js";

export class PrivateRoomRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByRoomId(
    roomId: string,
    _options?: { projection?: Record<string, number>; session?: unknown }
  ): Promise<PrivateRoom | null> {
    return this.prisma.privateRoom.findUnique({ where: { roomId } });
  }

  async allocateSequence(roomId: string): Promise<number> {
    // Bursty concurrent sends all `$inc` the same PrivateRoom document; retry
    // the transient Mongo write-conflict (Prisma P2034) so fast/parallel sends
    // don't fail with a user-visible SERVICE_ERROR. See withWriteConflictRetry.
    const r = await withWriteConflictRetry(() =>
      this.prisma.privateRoom.update({
        where: { roomId },
        data: { lastSequence: { increment: 1 } },
        select: { lastSequence: true },
      })
    );
    return r.lastSequence;
  }

  /**
   * Atomically allocate the next per-room CHANGE revision (Telegram `pts`).
   * Same atomic-`$inc` + write-conflict-retry pattern as `allocateSequence`, but on
   * `lastRevision` and bumped on EVERY content change (insert, edit, delete-for-everyone,
   * reaction) — not only on insert. Feeds the zero-loss `/changes` feed.
   */
  async allocateRevision(roomId: string): Promise<number> {
    const r = await withWriteConflictRetry(() =>
      this.prisma.privateRoom.update({
        where: { roomId },
        data: { lastRevision: { increment: 1 } },
        select: { lastRevision: true },
      })
    );
    return r.lastRevision;
  }

  /** Current room CHANGE high-water — the client seeds/compares its cursor against this. */
  async getRoomRevision(roomId: string): Promise<number> {
    const room = await this.prisma.privateRoom.findUnique({
      where: { roomId },
      select: { lastRevision: true },
    });
    return room?.lastRevision ?? 0;
  }

  async findByParticipantsKey(key: string): Promise<PrivateRoom | null> {
    return this.prisma.privateRoom.findUnique({
      where: { participantsKey: key },
    });
  }

  /**
   * Batch lookup for User Search: resolves many candidate peer rooms in one
   * indexed `$in` query against the @unique participantsKey column instead of
   * N single-key lookups.
   */
  async findByParticipantsKeys(keys: string[]): Promise<PrivateRoom[]> {
    if (keys.length === 0) return [];
    return this.prisma.privateRoom.findMany({
      where: { participantsKey: { in: keys } },
    });
  }

  /**
   * User Search: capped list of {peerId, roomId} pairs for every private
   * room the user participates in — used to classify search-matched users
   * into "has a room" (Chat) vs "doesn't" (Other) without a per-candidate
   * round trip. Ordered by lastMessageAt desc so a truncated cap keeps the
   * most-relevant (most-recently-active) rooms.
   */
  async findPeersForUser(
    userId: string,
    limit: number
  ): Promise<Array<{ peerId: string; roomId: string }>> {
    const rooms = await this.prisma.privateRoom.findMany({
      where: { participants: { has: userId } },
      select: { roomId: true, participants: true },
      orderBy: { lastMessageAt: "desc" },
      take: limit,
    });
    return rooms
      .map((r) => {
        const peerId = r.participants.find((p) => p !== userId);
        return peerId ? { peerId, roomId: r.roomId } : null;
      })
      .filter((x): x is { peerId: string; roomId: string } => x !== null);
  }

  /**
   * Presence fan-out: lean {roomId, peerId, lastMessage snapshot} for every
   * private room the user participates in — used to re-bump `conv:updated`
   * (with a fresh `isOffline`) to each peer when this user's presence flips.
   * Same participants-array query shape as {@link findPeersForUser}, just with
   * the last-message fields the bump payload needs.
   */
  async findRoomsForPresenceBump(
    userId: string,
    limit: number
  ): Promise<
    Array<{
      roomId: string;
      peerId: string;
      lastMessageId: string | null;
      lastMessage: unknown;
      lastMessageAt: Date | null;
    }>
  > {
    const rooms = await this.prisma.privateRoom.findMany({
      where: { participants: { has: userId } },
      select: {
        roomId: true,
        participants: true,
        lastMessageId: true,
        lastMessage: true,
        lastMessageAt: true,
      },
      orderBy: { lastMessageAt: "desc" },
      take: limit,
    });
    return rooms
      .map((r) => {
        const peerId = r.participants.find((p) => p !== userId);
        return peerId
          ? {
              roomId: r.roomId,
              peerId,
              lastMessageId: r.lastMessageId,
              lastMessage: r.lastMessage,
              lastMessageAt: r.lastMessageAt,
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }

  async create(data: {
    roomId: string;
    participants: string[];
    participantsKey: string;
    [key: string]: unknown;
  }): Promise<PrivateRoom> {
    return this.prisma.privateRoom.create({
      data: {
        roomId: data.roomId,
        participants: data.participants,
        participantsKey: data.participantsKey,
        lastMessageId: (data.lastMessageId as string) ?? null,
        lastMessageAt: (data.lastMessageAt as Date) ?? null,
        lastMessage: (data.lastMessage as object) ?? undefined,
        unreadCountByUser: (data.unreadCountByUser as object) ?? {},
        lastReadAtByUser: (data.lastReadAtByUser as object) ?? {},
        lastReadMessageIdByUser: (data.lastReadMessageIdByUser as object) ?? {},
        hasUnreadByUser: (data.hasUnreadByUser as object) ?? {},
        firstUnreadMessageIdByUser:
          (data.firstUnreadMessageIdByUser as object) ?? {},
        lastUnreadMessageIdByUser:
          (data.lastUnreadMessageIdByUser as object) ?? {},
        lastUnreadPreviewByUser: (data.lastUnreadPreviewByUser as object) ?? {},
        blockedBy: (data.blockedBy as object) ?? [],
        deletedFor: (data.deletedFor as object) ?? {},
        pinnedCount: (data.pinnedCount as number) ?? 0,
        lastPinnedAt: (data.lastPinnedAt as Date) ?? null,
      },
    });
  }

  async getConversationList(params: {
    userId: string;
    limit: number;
    cursor?: string | null;
  }): Promise<PrivateRoom[]> {
    return this.prisma.privateRoom.findMany({
      where: {
        participants: { has: params.userId },
        lastMessageAt: params.cursor
          ? { lt: new Date(params.cursor), not: null }
          : { not: null },
      },
      orderBy: { lastMessageAt: "desc" },
      take: params.limit,
    });
  }

  async countConversations(userId: string): Promise<number> {
    return this.prisma.privateRoom.count({
      where: { participants: { has: userId }, lastMessageAt: { not: null } },
    });
  }

  /**
   * Timestamp-bounded conversation fetch for the unified inbox.
   * - direction "before": lastMessageAt <= ts, newest-first (desc).
   * - direction "after" : lastMessageAt >= ts, oldest-first (asc).
   * Rooms without a lastMessageAt are excluded (no position in a time-ordered
   * list), matching getConversationList.
   */
  async getInboxConversations(params: {
    userId: string;
    direction: "before" | "after";
    ts: Date;
    /** V2 keyset tiebreaker parsed from a compound "<ms>_<roomId>" cursor. */
    boundaryId?: string | null;
    /** V1 inclusive bound (default); V2 passes false for a strict keyset. */
    inclusive?: boolean;
    limit: number;
  }): Promise<PrivateRoom[]> {
    const dir = params.direction === "before" ? "desc" : "asc";
    return this.prisma.privateRoom.findMany({
      where: {
        participants: { has: params.userId },
        ...buildRoomKeysetWhere(params),
      },
      orderBy: [{ lastMessageAt: dir }, { roomId: dir }],
      take: params.limit,
    });
  }

  async updateRoomOnNewMessage(params: {
    roomId: string;
    message: {
      _id: string;
      content: unknown;
      senderId: string;
      messageType: string;
      systemEvent?: string | null;
      systemData?: unknown;
      createdAt: Date;
    };
    receiverId: string;
    /** How many unread rows this send contributes (albums > 1). */
    unreadIncrement?: number;
  }): Promise<PrivateRoom | null> {
    const { roomId, message, receiverId } = params;
    const now = message.createdAt || new Date();

    // We need to read-then-write for the Map-based fields
    const existing = await this.prisma.privateRoom.findUnique({
      where: { roomId },
    });
    if (!existing) return null;

    const unreadCountByUser = (existing.unreadCountByUser ?? {}) as Record<
      string,
      number
    >;
    const unreadIncrement = params.unreadIncrement ?? 1;
    if (unreadIncrement > 0) {
      unreadCountByUser[receiverId] =
        (unreadCountByUser[receiverId] || 0) + unreadIncrement;
    }

    const hasUnreadByUser = (existing.hasUnreadByUser ?? {}) as Record<
      string,
      boolean
    >;
    if (unreadIncrement > 0) hasUnreadByUser[receiverId] = true;

    const lastUnreadMessageIdByUser = (existing.lastUnreadMessageIdByUser ??
      {}) as Record<string, string>;
    if (unreadIncrement > 0)
      lastUnreadMessageIdByUser[receiverId] = message._id;

    const lastUnreadPreviewByUser = (existing.lastUnreadPreviewByUser ??
      {}) as Record<string, unknown>;
    if (unreadIncrement > 0) {
      lastUnreadPreviewByUser[receiverId] = {
        content: message.content,
        senderId: message.senderId,
        messageType: message.messageType,
        systemEvent: message.systemEvent || null,
        systemData: message.systemData || null,
        createdAt: now,
        messageId: message._id,
      };
    }

    return this.prisma.privateRoom.update({
      where: { roomId },
      data: {
        lastMessageId: message._id,
        lastMessageAt: now,
        lastMessage: {
          content: message.content as Prisma.InputJsonValue,
          senderId: message.senderId,
          messageType: message.messageType,
          systemEvent: message.systemEvent || null,
          systemData: message.systemData || null,
          createdAt: now.toISOString(),
        } as unknown as Prisma.InputJsonValue,
        unreadCountByUser:
          unreadCountByUser as unknown as Prisma.InputJsonValue,
        hasUnreadByUser: hasUnreadByUser as unknown as Prisma.InputJsonValue,
        lastUnreadMessageIdByUser:
          lastUnreadMessageIdByUser as unknown as Prisma.InputJsonValue,
        lastUnreadPreviewByUser:
          lastUnreadPreviewByUser as unknown as Prisma.InputJsonValue,
        updatedAt: now,
      },
    });
  }

  async markReadUpTo(params: {
    roomId: string;
    userId: string;
    upToMessageId: string;
  }): Promise<PrivateRoom | null> {
    const { roomId, userId, upToMessageId } = params;
    const now = new Date();

    const existing = await this.prisma.privateRoom.findUnique({
      where: { roomId },
    });
    if (!existing) return null;

    const lastReadMessageIdByUser = (existing.lastReadMessageIdByUser ??
      {}) as Record<string, string>;

    // Forward-only: a read pointer must never move backward (multi-device — a second device that
    // read to an OLDER message would otherwise regress the pointer and wrongly re-zero unread).
    const upToSeq = (
      await this.prisma.privateMessage.findUnique({
        where: { id: upToMessageId },
        select: { sequenceNumber: true },
      })
    )?.sequenceNumber;
    const currentReadId = lastReadMessageIdByUser[userId];
    if (upToSeq != null && currentReadId) {
      const currentSeq = (
        await this.prisma.privateMessage.findUnique({
          where: { id: currentReadId },
          select: { sequenceNumber: true },
        })
      )?.sequenceNumber;
      if (currentSeq != null && upToSeq <= currentSeq) return existing;
    }

    // Accurate remaining unread = inbound messages strictly newer than the boundary (reading to a
    // non-latest message must leave unread > 0, not hard-zero).
    const remainingUnread =
      upToSeq != null
        ? await this.prisma.privateMessage.count({
            where: {
              roomId,
              senderId: { not: userId },
              isDeleted: false,
              sequenceNumber: { gt: upToSeq },
            },
          })
        : 0;

    const unreadCountByUser = (existing.unreadCountByUser ?? {}) as Record<
      string,
      number
    >;
    unreadCountByUser[userId] = remainingUnread;

    const lastReadAtByUser = (existing.lastReadAtByUser ?? {}) as Record<
      string,
      string
    >;
    lastReadAtByUser[userId] = now.toISOString();

    lastReadMessageIdByUser[userId] = upToMessageId;

    const hasUnread = remainingUnread > 0;
    const hasUnreadByUser = (existing.hasUnreadByUser ?? {}) as Record<
      string,
      boolean
    >;
    hasUnreadByUser[userId] = hasUnread;

    // Preview hints are only meaningful while unread remains; clear them once fully caught up.
    const firstUnreadMessageIdByUser = (existing.firstUnreadMessageIdByUser ??
      {}) as Record<string, string | null>;
    const lastUnreadMessageIdByUser = (existing.lastUnreadMessageIdByUser ??
      {}) as Record<string, string | null>;
    const lastUnreadPreviewByUser = (existing.lastUnreadPreviewByUser ??
      {}) as Record<string, unknown>;
    if (!hasUnread) {
      firstUnreadMessageIdByUser[userId] = null;
      lastUnreadMessageIdByUser[userId] = null;
      lastUnreadPreviewByUser[userId] = null;
    }

    return this.prisma.privateRoom.update({
      where: { roomId },
      data: {
        unreadCountByUser:
          unreadCountByUser as unknown as Prisma.InputJsonValue,
        lastReadAtByUser: lastReadAtByUser as unknown as Prisma.InputJsonValue,
        lastReadMessageIdByUser:
          lastReadMessageIdByUser as unknown as Prisma.InputJsonValue,
        hasUnreadByUser: hasUnreadByUser as unknown as Prisma.InputJsonValue,
        firstUnreadMessageIdByUser:
          firstUnreadMessageIdByUser as unknown as Prisma.InputJsonValue,
        lastUnreadMessageIdByUser:
          lastUnreadMessageIdByUser as unknown as Prisma.InputJsonValue,
        lastUnreadPreviewByUser:
          lastUnreadPreviewByUser as unknown as Prisma.InputJsonValue,
        updatedAt: now,
      },
    });
  }

  async decrementUnreadForMessage(params: {
    roomId: string;
    recipientId: string;
    messageId: string;
    messageCreatedAt: Date;
  }): Promise<void> {
    const existing = await this.prisma.privateRoom.findUnique({
      where: { roomId: params.roomId },
    });
    if (!existing) return;

    const lastReadAtByUser = (existing.lastReadAtByUser ?? {}) as Record<
      string,
      string
    >;
    const lastReadAt = lastReadAtByUser[params.recipientId]
      ? new Date(lastReadAtByUser[params.recipientId]!)
      : null;
    if (lastReadAt && lastReadAt >= params.messageCreatedAt) return;

    const unreadCountByUser = (existing.unreadCountByUser ?? {}) as Record<
      string,
      number
    >;
    unreadCountByUser[params.recipientId] = Math.max(
      0,
      (unreadCountByUser[params.recipientId] || 0) - 1
    );

    const hasUnreadByUser = (existing.hasUnreadByUser ?? {}) as Record<
      string,
      boolean
    >;
    hasUnreadByUser[params.recipientId] =
      (unreadCountByUser[params.recipientId] || 0) > 0;

    const lastUnreadMessageIdByUser = (existing.lastUnreadMessageIdByUser ??
      {}) as Record<string, string | null>;
    const lastUnreadPreviewByUser = (existing.lastUnreadPreviewByUser ??
      {}) as Record<string, unknown>;
    if (lastUnreadMessageIdByUser[params.recipientId] === params.messageId) {
      lastUnreadMessageIdByUser[params.recipientId] = null;
      lastUnreadPreviewByUser[params.recipientId] = null;
    }

    await this.prisma.privateRoom.update({
      where: { roomId: params.roomId },
      data: {
        unreadCountByUser:
          unreadCountByUser as unknown as Prisma.InputJsonValue,
        hasUnreadByUser: hasUnreadByUser as unknown as Prisma.InputJsonValue,
        lastUnreadMessageIdByUser:
          lastUnreadMessageIdByUser as unknown as Prisma.InputJsonValue,
        lastUnreadPreviewByUser:
          lastUnreadPreviewByUser as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async incPinnedCount(
    roomId: string,
    inc: number,
    _options?: { session?: unknown }
  ): Promise<PrivateRoom | null> {
    return this.prisma.privateRoom.update({
      where: { roomId },
      data: {
        pinnedCount: { increment: inc },
        ...(inc > 0 ? { lastPinnedAt: new Date() } : {}),
      },
    });
  }

  /**
   * Overwrite the room's last-message snapshot after a delete-for-everyone
   * removes the current last message. Accepts null to clear (no visible messages
   * remain). Unlike updateRoomOnNewMessage, this does not touch unread counts.
   */
  async setLastMessage(
    roomId: string,
    message: {
      id: string;
      senderId: string;
      content: unknown;
      messageType: string;
      createdAt: Date;
    } | null
  ): Promise<void> {
    await this.prisma.privateRoom.update({
      where: { roomId },
      data: message
        ? {
            lastMessageId: message.id,
            lastMessageAt: message.createdAt,
            lastMessage: {
              content: message.content as Prisma.InputJsonValue,
              senderId: message.senderId,
              messageType: message.messageType,
              createdAt: message.createdAt.toISOString(),
            } as unknown as Prisma.InputJsonValue,
          }
        : {
            lastMessageId: null,
            lastMessageAt: null,
            lastMessage: null as unknown as Prisma.InputJsonValue,
          },
    });
  }

  async setDeletedFor(roomId: string, userId: string): Promise<void> {
    const existing = await this.prisma.privateRoom.findUnique({
      where: { roomId },
    });
    if (!existing) return;

    const deletedFor = (existing.deletedFor ?? {}) as Record<string, string>;
    deletedFor[userId] = new Date().toISOString();

    await this.prisma.privateRoom.update({
      where: { roomId },
      data: { deletedFor },
    });
  }

  async setMuted(
    roomId: string,
    userId: string,
    muteUntil: Date | null
  ): Promise<PrivateRoom | null> {
    const existing = await this.prisma.privateRoom.findUnique({
      where: { roomId },
    });
    if (!existing) return null;

    const mutedBy = (existing.mutedBy ?? {}) as Record<string, unknown>;
    mutedBy[userId] = {
      mutedAt: new Date().toISOString(),
      muteUntil: muteUntil ? muteUntil.toISOString() : null,
    };

    return this.prisma.privateRoom.update({
      where: { roomId },
      data: { mutedBy: mutedBy as unknown as Prisma.InputJsonValue },
    });
  }

  async setUnmuted(
    roomId: string,
    userId: string
  ): Promise<PrivateRoom | null> {
    const existing = await this.prisma.privateRoom.findUnique({
      where: { roomId },
    });
    if (!existing) return null;

    const mutedBy = (existing.mutedBy ?? {}) as Record<string, unknown>;
    delete mutedBy[userId];

    return this.prisma.privateRoom.update({
      where: { roomId },
      data: { mutedBy: mutedBy as unknown as Prisma.InputJsonValue },
    });
  }

  async setArchived(
    roomId: string,
    userId: string
  ): Promise<PrivateRoom | null> {
    const existing = await this.prisma.privateRoom.findUnique({
      where: { roomId },
    });
    if (!existing) return null;

    const archivedBy = (existing.archivedBy ?? {}) as Record<string, unknown>;
    archivedBy[userId] = { archivedAt: new Date().toISOString() };

    return this.prisma.privateRoom.update({
      where: { roomId },
      data: { archivedBy: archivedBy as unknown as Prisma.InputJsonValue },
    });
  }

  async setUnarchived(
    roomId: string,
    userId: string
  ): Promise<PrivateRoom | null> {
    const existing = await this.prisma.privateRoom.findUnique({
      where: { roomId },
    });
    if (!existing) return null;

    const archivedBy = (existing.archivedBy ?? {}) as Record<string, unknown>;
    delete archivedBy[userId];

    return this.prisma.privateRoom.update({
      where: { roomId },
      data: { archivedBy: archivedBy as unknown as Prisma.InputJsonValue },
    });
  }
}
