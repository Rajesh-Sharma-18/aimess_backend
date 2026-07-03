import type {
  PrismaClient,
  PrivateRoom,
  Prisma,
} from "../generated/prisma/index.js";
import { withWriteConflictRetry } from "../lib/db-errors.js";

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

  async findByParticipantsKey(key: string): Promise<PrivateRoom | null> {
    return this.prisma.privateRoom.findUnique({
      where: { participantsKey: key },
    });
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
    limit: number;
  }): Promise<PrivateRoom[]> {
    const bound =
      params.direction === "before"
        ? { lte: params.ts, not: null }
        : { gte: params.ts, not: null };
    const dir = params.direction === "before" ? "desc" : "asc";
    return this.prisma.privateRoom.findMany({
      where: {
        participants: { has: params.userId },
        lastMessageAt: bound,
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
    unreadCountByUser[receiverId] =
      (unreadCountByUser[receiverId] || 0) + (params.unreadIncrement ?? 1);

    const hasUnreadByUser = (existing.hasUnreadByUser ?? {}) as Record<
      string,
      boolean
    >;
    hasUnreadByUser[receiverId] = true;

    const lastUnreadMessageIdByUser = (existing.lastUnreadMessageIdByUser ??
      {}) as Record<string, string>;
    lastUnreadMessageIdByUser[receiverId] = message._id;

    const lastUnreadPreviewByUser = (existing.lastUnreadPreviewByUser ??
      {}) as Record<string, unknown>;
    lastUnreadPreviewByUser[receiverId] = {
      content: message.content,
      senderId: message.senderId,
      messageType: message.messageType,
      systemEvent: message.systemEvent || null,
      systemData: message.systemData || null,
      createdAt: now,
      messageId: message._id,
    };

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

    const unreadCountByUser = (existing.unreadCountByUser ?? {}) as Record<
      string,
      number
    >;
    unreadCountByUser[userId] = 0;

    const lastReadAtByUser = (existing.lastReadAtByUser ?? {}) as Record<
      string,
      string
    >;
    lastReadAtByUser[userId] = now.toISOString();

    const lastReadMessageIdByUser = (existing.lastReadMessageIdByUser ??
      {}) as Record<string, string>;
    lastReadMessageIdByUser[userId] = upToMessageId;

    const hasUnreadByUser = (existing.hasUnreadByUser ?? {}) as Record<
      string,
      boolean
    >;
    hasUnreadByUser[userId] = false;

    const firstUnreadMessageIdByUser = (existing.firstUnreadMessageIdByUser ??
      {}) as Record<string, string | null>;
    firstUnreadMessageIdByUser[userId] = null;

    const lastUnreadMessageIdByUser = (existing.lastUnreadMessageIdByUser ??
      {}) as Record<string, string | null>;
    lastUnreadMessageIdByUser[userId] = null;

    const lastUnreadPreviewByUser = (existing.lastUnreadPreviewByUser ??
      {}) as Record<string, unknown>;
    lastUnreadPreviewByUser[userId] = null;

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
