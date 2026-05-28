import { BadRequestError, NotFoundError } from "@aimess/errors";

import type { GeneralRoomRepository } from "../repositories/general-room.repository.js";
import type { RoomMemberRepository } from "../repositories/room-member.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { GeneralRoom } from "../generated/prisma/index.js";

export class CommunityRoomService {
  constructor(
    private readonly roomRepo: GeneralRoomRepository,
    private readonly memberRepo: RoomMemberRepository,
    private readonly cacheRepo: CacheRepository
  ) {}

  async getRooms(userId: string | null): Promise<GeneralRoom[]> {
    const rooms = await this.roomRepo.findActiveRooms();

    if (!userId) return rooms;

    // Attach read timestamps for unread indicators
    const readTimestamps =
      await this.cacheRepo.getGeneralRoomReadTimestamps(userId);

    return rooms.map((room) => {
      const roomId = room.id;
      const lastReadTs = readTimestamps[roomId]
        ? Number(readTimestamps[roomId])
        : 0;
      const lastMsgTs = room.lastMessageAt
        ? new Date(room.lastMessageAt).getTime()
        : 0;

      return {
        ...room,
        hasUnread: lastMsgTs > lastReadTs,
      } as GeneralRoom & { hasUnread: boolean };
    });
  }

  async searchRooms(query: string): Promise<GeneralRoom[]> {
    return this.roomRepo.searchRooms(query);
  }

  async join(roomId: string, userId: string): Promise<void> {
    const room = await this.roomRepo.findRoomById(roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");

    const isBanned = await this.memberRepo.isBanned(roomId, userId);
    if (isBanned) throw new BadRequestError("CHAT_BANNED_FROM_ROOM");

    await this.memberRepo.upsert(roomId, userId, {
      status: "active",
      role: "member",
      joinedAt: new Date(),
    } as Record<string, unknown>);

    await this.roomRepo.incMemberNumber(roomId, 1);
  }

  async leave(roomId: string, userId: string): Promise<void> {
    await this.memberRepo.updateStatus(roomId, userId, "active", {
      leftAt: new Date(),
    });
    await this.roomRepo.incMemberNumber(roomId, -1);
  }

  async ban(params: {
    roomId: string;
    userId: string;
    bannedBy: string;
    reason?: string;
  }): Promise<void> {
    await this.memberRepo.updateStatus(params.roomId, params.userId, "banned", {
      bannedAt: new Date(),
      banInfo: {
        bannedAt: new Date(),
        bannedBy: params.bannedBy,
        banReason: params.reason || null,
        banType: "PERMANENT",
        source: "APP",
      },
    });
  }

  async countRooms(): Promise<number> {
    return this.roomRepo.countActiveRooms();
  }

  async countSearchResults(query: string): Promise<number> {
    return this.roomRepo.countSearchResults(query);
  }

  async assertNotBanned(roomId: string, userId: string): Promise<void> {
    const isBanned = await this.memberRepo.isBanned(roomId, userId);
    if (isBanned) {
      const error = new BadRequestError("CHAT_BANNED_FROM_ROOM");
      (error as unknown as Record<string, string>).code = "BANNED";
      throw error;
    }
  }
}
