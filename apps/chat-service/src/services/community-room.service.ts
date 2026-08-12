import { BadRequestError, NotFoundError } from "@aimess/errors";

import { assertCommunityMember } from "../lib/access-guard.js";
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
  liveStreamCount: number;
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

  /**
   * One page of the community rooms this viewer may SEE: every PUBLIC community
   * plus the ones they hold a membership row in. PRIVATE communities the caller
   * is not in are excluded at the query — they used to be returned to ANY
   * caller (the route was unauthenticated too), which leaked the community's
   * existence, name and its `lastMessage` preview text.
   */
  async getRooms(
    userId: string,
    page = 1,
    limit = 20
  ): Promise<CommunityRoomView[]> {
    const memberRoomIds =
      await this.memberRepo.findVisibleRoomIdsByUser(userId);
    const rooms = await this.roomRepo.findVisibleRooms({
      memberRoomIds,
      skip: Math.max(0, (page - 1) * limit),
      take: limit,
    });
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
        liveStreamCount: count,
      };
    };

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

  /** Same visibility rule as {@link getRooms}, applied to the text search. */
  async searchRooms(
    query: string,
    userId: string,
    page = 1,
    limit = 20
  ): Promise<GeneralRoom[]> {
    const memberRoomIds =
      await this.memberRepo.findVisibleRoomIdsByUser(userId);
    return this.roomRepo.searchRooms({
      query,
      memberRoomIds,
      skip: Math.max(0, (page - 1) * limit),
      take: limit,
    });
  }

  /**
   * Attach the caller's chat-side membership mirror for a community they ALREADY
   * belong to. This is a mirror SYNC, never a grant.
   *
   * It used to upsert `RoomMember{status:"active"}` after only a ban check, so
   * any authenticated user could POST this route for any roomId — including a
   * PRIVATE community — and self-grant a membership row. Every community guard
   * (`assertCommunityMember`, `assertCommunityReadAccess`) trusts that row, so
   * the forged mirror bought full read AND write access to a private
   * community's chat.
   *
   * Membership is owned by community-service. `assertCommunityMember` is the one
   * place that asks it: it short-circuits on an already-active mirror, and
   * otherwise does the authoritative `checkCommunityMembership` lookup and heals
   * the mirror only when community-service confirms ACTIVE — the exact
   * heal-don't-grant behaviour this route needs. Non-members get
   * `CHAT_NOT_A_MEMBER`, banned callers `USER_BANNED`.
   *
   * `memberNumber` is deliberately NOT incremented any more: the count is
   * maintained by the `community.member.synced` consumer, so bumping it here
   * double-counted every join (and inflated it further on each repeat call).
   */
  async join(roomId: string, userId: string): Promise<void> {
    const room = await this.roomRepo.findRoomById(roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");

    await assertCommunityMember(this.memberRepo, roomId, userId);
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

  async countRooms(userId: string): Promise<number> {
    const memberRoomIds =
      await this.memberRepo.findVisibleRoomIdsByUser(userId);
    return this.roomRepo.countVisibleRooms(memberRoomIds);
  }

  async countSearchResults(query: string, userId: string): Promise<number> {
    const memberRoomIds =
      await this.memberRepo.findVisibleRoomIdsByUser(userId);
    return this.roomRepo.countSearchResults(query, memberRoomIds);
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
