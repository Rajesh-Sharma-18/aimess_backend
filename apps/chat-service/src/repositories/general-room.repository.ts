import type { PrismaClient, GeneralRoom } from "../generated/prisma/index.js";

export class GeneralRoomRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findRoomById(roomId: string): Promise<GeneralRoom | null> {
    return this.prisma.generalRoom.findUnique({ where: { id: roomId } });
  }

  /** Bulk fetch rooms by id (community-chat summaries enrichment). */
  async findManyByIds(ids: string[]): Promise<GeneralRoom[]> {
    if (!ids.length) return [];
    return this.prisma.generalRoom.findMany({ where: { id: { in: ids } } });
  }

  /**
   * All room ids with their status — the diff target for the boot reconciler so
   * it can tell which communities already have a (de)activated chat room.
   */
  async listAllIdsWithStatus(): Promise<Array<{ id: string; status: string }>> {
    return this.prisma.generalRoom.findMany({
      select: { id: true, status: true },
    });
  }

  async findActiveRooms(): Promise<GeneralRoom[]> {
    return this.prisma.generalRoom.findMany({
      where: { status: "active" },
      orderBy: [{ displayOrder: "asc" }, { lastMessageAt: "desc" }],
    });
  }

  async searchRooms(query: string): Promise<GeneralRoom[]> {
    // Prisma MongoDB doesn't support $regex via the standard API.
    // Use raw query for regex-based search.
    return this.prisma.generalRoom.findMany({
      where: {
        status: "active",
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { title: { contains: query, mode: "insensitive" } },
          { tags: { has: query.toLowerCase() } },
        ],
      },
      orderBy: { memberNumber: "desc" },
      take: 20,
    });
  }

  async countActiveRooms(): Promise<number> {
    return this.prisma.generalRoom.count({ where: { status: "active" } });
  }

  async countSearchResults(query: string): Promise<number> {
    return this.prisma.generalRoom.count({
      where: {
        status: "active",
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { title: { contains: query, mode: "insensitive" } },
          { tags: { has: query.toLowerCase() } },
        ],
      },
    });
  }

  async addLastestMessageToRoom(
    roomId: string,
    message: {
      _id: unknown;
      sentBy: string;
      senderName: string;
      message: string;
      messageType: string;
      createdAt: Date;
    }
  ): Promise<GeneralRoom | null> {
    return this.prisma.generalRoom.update({
      where: { id: roomId },
      data: {
        lastMessageId: String(message._id),
        lastMessageAt: message.createdAt,
        lastMessage: {
          content: message.message,
          senderId: message.sentBy,
          senderName: message.senderName,
          messageType: message.messageType,
          createdAt: message.createdAt,
        },
      },
    });
  }

  async incMemberNumber(roomId: string, inc: number): Promise<void> {
    await this.prisma.generalRoom.update({
      where: { id: roomId },
      data: { memberNumber: { increment: inc } },
    });
  }

  async isRoomMember(_roomId: string, _userId: string): Promise<boolean> {
    // Community rooms are open -- membership is tracked in room_members
    // Return true as a default for general rooms (open communities)
    return true;
  }

  /**
   * Provision (idempotently) the chat room backing a community-service Community.
   * The room's `id` is the Community's id, so `roomId === communityId` across the
   * whole community-chat path. Driven by the `community.created` sync event.
   */
  async provisionForCommunity(
    communityId: string,
    data: { name: string; owner?: string | null; logo?: string | null }
  ): Promise<void> {
    await this.prisma.generalRoom.upsert({
      where: { id: communityId },
      create: {
        id: communityId,
        name: data.name,
        owner: data.owner ?? null,
        logo: data.logo ?? null,
        status: "active",
      },
      update: {
        // Keep room metadata in sync, and re-activate if it was soft-removed.
        name: data.name,
        logo: data.logo ?? null,
        status: "active",
      },
    });
  }

  async incPinnedCount(
    roomId: string,
    inc: number
  ): Promise<GeneralRoom | null> {
    return this.prisma.generalRoom.update({
      where: { id: roomId },
      data: {
        pinnedCount: { increment: inc },
        ...(inc > 0 ? { lastPinnedAt: new Date() } : {}),
      },
    });
  }

  /** Soft-deactivate a community's chat room (driven by `community.deleted`). */
  async deactivateForCommunity(communityId: string): Promise<void> {
    await this.prisma.generalRoom.updateMany({
      where: { id: communityId },
      data: { status: "inactive" },
    });
  }

  /**
   * Suspend a community's chat room (driven by `community.status.changed` with
   * status=SUSPENDED). Sets room status to "suspended" so `sendMessage` blocks
   * new messages. Members can still read history.
   */
  async suspendForCommunity(communityId: string): Promise<void> {
    await this.prisma.generalRoom.updateMany({
      where: { id: communityId, status: "active" },
      data: { status: "suspended" },
    });
  }

  /**
   * Unsuspend a community's chat room (driven by `community.status.changed` with
   * status=ACTIVE). Only transitions rooms that are currently "suspended" so a
   * reopen can never accidentally reactivate a hard-deleted ("inactive") room.
   */
  async unsuspendForCommunity(communityId: string): Promise<void> {
    await this.prisma.generalRoom.updateMany({
      where: { id: communityId, status: "suspended" },
      data: { status: "active" },
    });
  }
}
