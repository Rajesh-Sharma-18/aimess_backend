import { BadRequestError, NotFoundError } from "@aimess/errors";

import type { GeneralRoomRepository } from "../repositories/general-room.repository.js";
import type { RoomMemberRepository } from "../repositories/room-member.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { GeneralRoom } from "../generated/prisma/index.js";
import {
  getStreamCountsClient,
  type StreamCountsClient,
} from "../grpc/stream.client.js";

/** Platform cap on concurrent LIVE streams per community (see stream-service). */
const MAX_ACTIVE_LIVESTREAMS = 5;

/** A community room enriched with livestream state (+ unread for authed callers). */
export type CommunityRoomView = GeneralRoom & {
  /** Alias of hasActiveLivestream — matches the documented ChatCommunityRoom.isLive. */
  isLive: boolean;
  hasActiveLivestream: boolean;
  activeLivestreamCount: number;
  hasUnread?: boolean;
};

export class CommunityRoomService {
  constructor(
    private readonly roomRepo: GeneralRoomRepository,
    private readonly memberRepo: RoomMemberRepository,
    private readonly cacheRepo: CacheRepository,
    // Injectable for tests; defaults to the shared singleton in production.
    private readonly streamClient: StreamCountsClient = getStreamCountsClient()
  ) {}

  /**
   * Batched LIVE-only stream count per community (room id === communityId). One
   * gRPC call for the whole list — no N+1. Fail-open: an empty map on error so
   * the rooms list degrades to "no live streams" rather than failing.
   */
  private async fetchLiveCounts(
    communityIds: string[]
  ): Promise<Map<string, number>> {
    if (!communityIds.length) return new Map();
    try {
      return await this.streamClient.getActiveStreamCounts(communityIds);
    } catch {
      return new Map();
    }
  }

  async getRooms(userId: string | null): Promise<CommunityRoomView[]> {
    const rooms = await this.roomRepo.findActiveRooms();
    const liveCounts = await this.fetchLiveCounts(rooms.map((r) => r.id));

    const withLivestream = (room: GeneralRoom): CommunityRoomView => {
      const count = Math.min(
        liveCounts.get(room.id) ?? 0,
        MAX_ACTIVE_LIVESTREAMS
      );
      return {
        ...room,
        isLive: count > 0,
        hasActiveLivestream: count > 0,
        activeLivestreamCount: count,
      };
    };

    // Anonymous callers get livestream state but no per-user unread (no token).
    if (!userId) return rooms.map(withLivestream);

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
        ...withLivestream(room),
        hasUnread: lastMsgTs > lastReadTs,
      };
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
    // Guard: only an active member can leave. Without this, leave was a no-op
    // that still decremented memberNumber, drifting the count (AUDIT H5).
    const member = await this.memberRepo.findByRoomAndUser(roomId, userId);
    if (!member || member.status !== "active") {
      throw new NotFoundError("CHAT_NOT_A_MEMBER");
    }

    // Must write "left" (the new status) — previously wrote "active", leaving
    // the member ACTIVE while still decrementing memberNumber.
    await this.memberRepo.updateStatus(roomId, userId, "left", {
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
