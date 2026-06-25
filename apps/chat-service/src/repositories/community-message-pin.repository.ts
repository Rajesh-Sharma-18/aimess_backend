import type {
  PrismaClient,
  CommunityMessagePin,
} from "../generated/prisma/index.js";

export class CommunityMessagePinRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createPin(data: {
    communityId: string;
    roomId: string;
    messageId: string;
    pinnedBy: string;
    pinnedAt?: Date;
    messageCreatedAt: Date;
    senderId: string;
    senderDisplayName?: string;
    senderAvatar?: string;
    contentPinned?: object;
  }): Promise<CommunityMessagePin> {
    return this.prisma.communityMessagePin.create({
      data: {
        communityId: data.communityId,
        roomId: data.roomId,
        messageId: data.messageId,
        pinnedBy: data.pinnedBy,
        pinnedAt: data.pinnedAt ?? new Date(),
        messageCreatedAt: data.messageCreatedAt,
        senderId: data.senderId,
        senderDisplayName: data.senderDisplayName ?? "",
        senderAvatar: data.senderAvatar ?? "",
        contentPinned: data.contentPinned ?? { text: "", urls: [], files: [] },
      },
    });
  }

  /** Find the single active pin for a room (unpinnedAt is null). */
  async findActivePinByRoom(
    roomId: string
  ): Promise<CommunityMessagePin | null> {
    return this.prisma.communityMessagePin.findFirst({
      where: { roomId, unpinnedAt: null },
      orderBy: { pinnedAt: "desc" },
    });
  }

  /** Count active pins for a room (for limit enforcement). */
  async countActivePinsByRoom(roomId: string): Promise<number> {
    return this.prisma.communityMessagePin.count({
      where: { roomId, unpinnedAt: null },
    });
  }

  /** Find the active pin for a specific message (for delete hook and unpin by messageId). */
  async findActivePinByMessageId(
    messageId: string
  ): Promise<CommunityMessagePin | null> {
    return this.prisma.communityMessagePin.findFirst({
      where: { messageId, unpinnedAt: null },
    });
  }

  async findPinById(id: string): Promise<CommunityMessagePin | null> {
    return this.prisma.communityMessagePin.findUnique({ where: { id } });
  }

  /** Soft-delete: set unpinnedAt + unpinnedByUserId instead of hard-deleting. */
  async softDeletePin(
    pinId: string,
    unpinnedByUserId: string,
    unpinnedAt: Date
  ): Promise<CommunityMessagePin | null> {
    try {
      return await this.prisma.communityMessagePin.update({
        where: { id: pinId },
        data: { unpinnedAt, unpinnedByUserId },
      });
    } catch {
      return null;
    }
  }

  /**
   * Mark originalMessageDeletedAt when the pinned message is hard-deleted.
   * Returns all affected pin records (may be multiple if message was repinned).
   */
  async markPinnedMessageDeleted(
    messageId: string,
    deletedAt: Date
  ): Promise<CommunityMessagePin[]> {
    // updateMany not supported in MongoDB Prisma — fetch then update individually.
    const active = await this.prisma.communityMessagePin.findMany({
      where: { messageId, unpinnedAt: null },
    });
    if (!active.length) return [];

    await Promise.all(
      active.map((pin) =>
        this.prisma.communityMessagePin.update({
          where: { id: pin.id },
          data: { originalMessageDeletedAt: deletedAt },
        })
      )
    );

    return active.map((p) => ({
      ...p,
      originalMessageDeletedAt: deletedAt,
      updatedAt: deletedAt,
    }));
  }

  /** Store the system message ID on the pin record (best-effort, called after system message creation). */
  async setPinSystemMessageId(
    pinId: string,
    systemMessageId: string
  ): Promise<void> {
    await this.prisma.communityMessagePin.update({
      where: { id: pinId },
      data: { pinSystemMessageId: systemMessageId },
    });
  }

  /** List active pins for a room, newest first, with compound cursor pagination. */
  async findPinsByRoom(
    roomId: string,
    params: { limit: number; cursor?: string | null }
  ): Promise<CommunityMessagePin[]> {
    let cursorFilter: { pinnedAt: { lt: Date } } | undefined;
    if (params.cursor) {
      // cursor = "<ms>_<id>" compound format
      const ms = parseInt(params.cursor.split("_")[0] ?? "0", 10);
      if (!Number.isNaN(ms)) {
        cursorFilter = { pinnedAt: { lt: new Date(ms) } };
      }
    }
    return this.prisma.communityMessagePin.findMany({
      where: {
        roomId,
        unpinnedAt: null,
        ...(cursorFilter ?? {}),
      },
      orderBy: { pinnedAt: "desc" },
      take: params.limit,
    });
  }

  /** @deprecated Kept for reference — use softDeletePin instead. */
  async deletePin(
    roomId: string,
    messageId: string
  ): Promise<{ deletedCount: number }> {
    const existing = await this.prisma.communityMessagePin.findFirst({
      where: { roomId, messageId, unpinnedAt: null },
    });
    if (!existing) return { deletedCount: 0 };
    await this.prisma.communityMessagePin.delete({
      where: { id: existing.id },
    });
    return { deletedCount: 1 };
  }

  /** @deprecated Use countActivePinsByRoom for limit checks. */
  async countPinsByRoom(roomId: string): Promise<number> {
    return this.countActivePinsByRoom(roomId);
  }
}
