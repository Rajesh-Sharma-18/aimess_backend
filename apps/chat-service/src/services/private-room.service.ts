import { ForbiddenError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import { buildParticipantsKey, generateRoomId } from "../lib/room-id.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { FriendshipRepository } from "../repositories/friendship.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import type { PrivateRoom } from "../generated/prisma/index.js";

export class PrivateRoomService {
  constructor(
    private readonly privateRoomRepo: PrivateRoomRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService,
    private readonly friendshipRepo: FriendshipRepository
  ) {}

  async getOrCreateRoom(userId: string, peerId: string): Promise<PrivateRoom> {
    const participantsKey = buildParticipantsKey(userId, peerId);
    const existing =
      await this.privateRoomRepo.findByParticipantsKey(participantsKey);
    if (existing) return existing;

    const friends = await this.friendshipRepo.areFriends(userId, peerId);
    if (!friends) {
      throw new ForbiddenError("CHAT_FRIENDSHIP_REQUIRED");
    }

    const roomId = generateRoomId("prv");
    const room = await this.privateRoomRepo.create({
      roomId,
      participants: [userId, peerId].sort(),
      participantsKey,
    });

    logger.debug(`PrivateRoomService|getOrCreateRoom|created room=${roomId}`);
    return room;
  }

  async getConversationList(params: {
    userId: string;
    limit: number;
    cursor?: string | null;
  }) {
    const rooms = await this.privateRoomRepo.getConversationList(params);

    // Enrich with peer info
    const peerIds = rooms
      .map((room) => {
        const participants = room.participants || [];
        return participants.find((p) => p !== params.userId) || "";
      })
      .filter(Boolean);

    const snapshots = await this.userSnapshotService.getUserSnapshotsMap(
      peerIds,
      this.cacheRepo
    );

    const enrichedRooms = rooms.map((room) => {
      const peerId =
        (room.participants || []).find((p) => p !== params.userId) || "";
      const snapshot = snapshots.get(peerId) || {};
      return {
        ...room,
        peerId,
        peer: {
          id: peerId,
          displayName: (snapshot as Record<string, unknown>).displayName || "",
          memberId: (snapshot as Record<string, unknown>).memberId || "",
          avatar: (snapshot as Record<string, unknown>).avatar || "",
          isDeletedUser:
            (snapshot as Record<string, unknown>).isDeletedUser === true,
          isOnline: (snapshot as Record<string, unknown>).isOnline || false,
        },
      };
    });

    return enrichedRooms;
  }

  async countConversations(userId: string): Promise<number> {
    return this.privateRoomRepo.countConversations(userId);
  }

  async deleteForMe(roomId: string, userId: string): Promise<void> {
    const room = await this.privateRoomRepo.findByRoomId(roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");

    const isParticipant = room.participants?.includes(userId);
    if (!isParticipant) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");

    await this.privateRoomRepo.setDeletedFor(roomId, userId);
  }
}
