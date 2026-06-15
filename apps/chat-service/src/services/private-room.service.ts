import { ForbiddenError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";

import { buildParticipantsKey, generateRoomId } from "../lib/room-id.js";
import { toWireMessage } from "../lib/chat-message.serializer.js";
import { resolveMediaUrlMap, urlFromMap } from "../lib/media-resolve.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { UserServiceClient } from "../grpc/user.client.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import type { PrivateRoom } from "../generated/prisma/index.js";

export interface PrivateRoomPeer {
  id: string;
  displayName: string;
  memberId: string;
  avatar: string;
  isDeletedUser: boolean;
  isOnline: boolean;
}

export type EnrichedPrivateRoom = PrivateRoom & {
  isMuted: boolean;
  peerId: string;
  peer: PrivateRoomPeer;
};

export class PrivateRoomService {
  constructor(
    private readonly privateRoomRepo: PrivateRoomRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService,
    private readonly userServiceClient: UserServiceClient,
    private readonly redis: Redis | Cluster
  ) {}

  async getOrCreateRoom(userId: string, peerId: string): Promise<PrivateRoom> {
    const participantsKey = buildParticipantsKey(userId, peerId);
    const existing =
      await this.privateRoomRepo.findByParticipantsKey(participantsKey);
    if (existing) return existing;

    const friends = await this.userServiceClient.checkFriendship(
      userId,
      peerId
    );
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

    // Notify both participants that a new conversation was opened.
    const convCreatedPayload = JSON.stringify({
      event: "conv:created",
      data: { roomId, participants: [userId, peerId] },
    });
    this.redis.publish(`user:${userId}`, convCreatedPayload).catch(() => {});
    this.redis.publish(`user:${peerId}`, convCreatedPayload).catch(() => {});

    return room;
  }

  async getConversationList(params: {
    userId: string;
    limit: number;
    cursor?: string | null;
  }): Promise<EnrichedPrivateRoom[]> {
    const rooms = await this.privateRoomRepo.getConversationList(params);
    return this.enrichConversations(rooms, params.userId);
  }

  /**
   * Timestamp-bounded conversation fetch for the unified inbox, enriched with
   * peer snapshot + mute state (same shape as getConversationList).
   */
  async getInboxConversations(params: {
    userId: string;
    direction: "before" | "after";
    ts: Date;
    limit: number;
  }): Promise<EnrichedPrivateRoom[]> {
    const rooms = await this.privateRoomRepo.getInboxConversations(params);
    return this.enrichConversations(rooms, params.userId);
  }

  /**
   * Attach the peer's user snapshot + the viewer's mute state to each room.
   * Shared by the cursor conversation list and the unified inbox so both expose
   * an identical private-room item shape.
   */
  private async enrichConversations(
    rooms: PrivateRoom[],
    userId: string
  ): Promise<EnrichedPrivateRoom[]> {
    const peerIds = rooms
      .map((room) => (room.participants || []).find((p) => p !== userId) || "")
      .filter(Boolean);

    const snapshots = await this.userSnapshotService.getUserSnapshotsMap(
      peerIds,
      this.cacheRepo
    );

    // Resolve peer avatar object keys → full download URLs (resolve on read).
    const avatarUrls = await resolveMediaUrlMap(
      [...snapshots.values()].map(
        (snap) => (snap as Record<string, unknown>).avatar as string
      )
    );

    const now = Date.now();
    return rooms.map((room) => {
      const peerId = (room.participants || []).find((p) => p !== userId) || "";
      const snapshot = (snapshots.get(peerId) || {}) as Record<string, unknown>;
      const mutedBy = (room.mutedBy ?? {}) as Record<
        string,
        { muteUntil?: string | null }
      >;
      const myMute = mutedBy[userId];
      const isMuted =
        myMute != null &&
        (myMute.muteUntil == null ||
          new Date(myMute.muteUntil).getTime() > now);
      // Normalize the embedded preview's kind field (messageType -> contentType)
      // so the conversation-list AND inbox-private rows match the canonical wire.
      const lm = room.lastMessage;
      const lastMessage = (lm && typeof lm === "object"
        ? toWireMessage(lm as { messageType?: string | null })
        : (lm ?? null)) as unknown as PrivateRoom["lastMessage"];
      return {
        ...room,
        lastMessage,
        isMuted,
        peerId,
        peer: {
          id: peerId,
          displayName: (snapshot.displayName as string) || "",
          memberId: (snapshot.memberId as string) || "",
          avatar: urlFromMap(avatarUrls, (snapshot.avatar as string) || ""),
          isDeletedUser: snapshot.isDeletedUser === true,
          isOnline: Boolean(snapshot.isOnline),
        },
      };
    });
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

    // Notify the user that the conversation was deleted from their view.
    this.redis
      .publish(
        `user:${userId}`,
        JSON.stringify({
          event: "conv:deleted",
          data: { roomId, deletedBy: userId },
        })
      )
      .catch(() => {});
  }

  async muteRoom(
    roomId: string,
    userId: string,
    muteUntil: Date | null
  ): Promise<PrivateRoom> {
    const room = await this.privateRoomRepo.findByRoomId(roomId);
    if (!room || !room.participants?.includes(userId))
      throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    const updated = await this.privateRoomRepo.setMuted(
      roomId,
      userId,
      muteUntil
    );
    return updated ?? room;
  }

  async unmuteRoom(roomId: string, userId: string): Promise<PrivateRoom> {
    const room = await this.privateRoomRepo.findByRoomId(roomId);
    if (!room || !room.participants?.includes(userId))
      throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    const updated = await this.privateRoomRepo.setUnmuted(roomId, userId);
    return updated ?? room;
  }

  async archiveRoom(roomId: string, userId: string): Promise<PrivateRoom> {
    const room = await this.privateRoomRepo.findByRoomId(roomId);
    if (!room || !room.participants?.includes(userId))
      throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    const updated = await this.privateRoomRepo.setArchived(roomId, userId);
    this.redis
      .publish(
        `user:${userId}`,
        JSON.stringify({
          event: "conv:archived",
          data: {
            roomId,
            type: "PRIVATE",
            archivedAt: Date.now(),
          },
        })
      )
      .catch(() => {});
    return updated ?? room;
  }

  async unarchiveRoom(roomId: string, userId: string): Promise<PrivateRoom> {
    const room = await this.privateRoomRepo.findByRoomId(roomId);
    if (!room || !room.participants?.includes(userId))
      throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    const updated = await this.privateRoomRepo.setUnarchived(roomId, userId);
    this.redis
      .publish(
        `user:${userId}`,
        JSON.stringify({
          event: "conv:unarchived",
          data: { roomId, type: "PRIVATE" },
        })
      )
      .catch(() => {});
    return updated ?? room;
  }
}
