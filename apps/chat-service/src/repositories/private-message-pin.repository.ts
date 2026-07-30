import type {
  PrismaClient,
  Prisma,
  PrivateMessagePin,
} from "../generated/prisma/index.js";

/** A `PrismaClient` or the interactive-transaction client Prisma hands the callback in `$transaction(async (tx) => ...)`. */
type PrismaOrTx = PrismaClient | Prisma.TransactionClient;

export class PrivateMessagePinRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Parity with CommunityMessagePinRepository — atomic replace-pin switch. */
  async runTransaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    return this.prisma.$transaction(fn);
  }

  async createPin(
    data: {
      roomId: string;
      messageId: string;
      pinnedBy: string;
      pinnedAt?: Date;
      messageCreatedAt: Date;
      senderId: string;
      senderDisplayName?: string;
      senderAvatar?: string;
      contentPinned?: object;
      deletedFor?: object;
      [key: string]: unknown;
    },
    client: PrismaOrTx = this.prisma
  ): Promise<PrivateMessagePin> {
    return client.privateMessagePin.create({
      data: {
        roomId: data.roomId,
        messageId: data.messageId,
        pinnedBy: data.pinnedBy,
        pinnedAt: (data.pinnedAt as Date) ?? new Date(),
        // Explicit — an absent key wouldn't match `unpinnedAt: null` filters.
        unpinnedAt: null,
        messageCreatedAt: data.messageCreatedAt,
        senderId: data.senderId,
        senderDisplayName: data.senderDisplayName ?? "",
        senderAvatar: data.senderAvatar ?? "",
        contentPinned: (data.contentPinned as object) ?? {
          text: "",
          urls: [],
          files: [],
        },
        deletedFor: (data.deletedFor as object) ?? {},
      },
    });
  }

  /** Find the single active pin for a room (unpinnedAt is null). */
  async findActivePinByRoom(
    roomId: string,
    client: PrismaOrTx = this.prisma
  ): Promise<PrivateMessagePin | null> {
    return client.privateMessagePin.findFirst({
      where: { roomId, unpinnedAt: null },
      orderBy: { pinnedAt: "desc" },
    });
  }

  /** Find the active pin for a specific message (for delete hook and unpin by messageId). */
  async findActivePinByMessageId(
    messageId: string
  ): Promise<PrivateMessagePin | null> {
    return this.prisma.privateMessagePin.findFirst({
      where: { messageId, unpinnedAt: null },
    });
  }

  /** Soft-delete: set unpinnedAt + unpinnedByUserId instead of hard-deleting. */
  async softDeletePin(
    pinId: string,
    unpinnedByUserId: string,
    unpinnedAt: Date,
    client: PrismaOrTx = this.prisma
  ): Promise<PrivateMessagePin | null> {
    try {
      return await client.privateMessagePin.update({
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
  ): Promise<PrivateMessagePin[]> {
    const active = await this.prisma.privateMessagePin.findMany({
      where: { messageId, unpinnedAt: null },
    });
    if (!active.length) return [];

    await Promise.all(
      active.map((pin) =>
        this.prisma.privateMessagePin.update({
          where: { id: pin.id },
          data: { originalMessageDeletedAt: deletedAt },
        })
      )
    );

    return active.map((p) => ({ ...p, originalMessageDeletedAt: deletedAt }));
  }

  /** Store the system message ID on the pin record (best-effort, called after system message creation). */
  async setPinSystemMessageId(
    pinId: string,
    systemMessageId: string
  ): Promise<void> {
    await this.prisma.privateMessagePin.update({
      where: { id: pinId },
      data: { pinSystemMessageId: systemMessageId },
    });
  }

  /** Count active pins for a room. */
  async countActivePinsByRoom(roomId: string): Promise<number> {
    return this.prisma.privateMessagePin.count({
      where: { roomId, unpinnedAt: null },
    });
  }

  /** List active pins for a room, newest first, with cursor pagination. */
  async findPinsByRoom(
    roomId: string,
    params: { limit: number; cursor?: string | null }
  ): Promise<PrivateMessagePin[]> {
    return this.prisma.privateMessagePin.findMany({
      where: {
        roomId,
        unpinnedAt: null,
        ...(params.cursor ? { pinnedAt: { lt: new Date(params.cursor) } } : {}),
      },
      orderBy: { pinnedAt: "desc" },
      take: params.limit,
    });
  }

  async findByRoomAndMessage(
    roomId: string,
    messageId: string
  ): Promise<PrivateMessagePin | null> {
    return this.prisma.privateMessagePin.findFirst({
      where: { roomId, messageId, unpinnedAt: null },
    });
  }
}
