import { ForbiddenError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";

import { buildParticipantsKey, generateRoomId } from "../lib/room-id.js";
import { toWireMessage } from "../lib/chat-message.serializer.js";
import { resolveMediaUrlMap, urlFromMap } from "../lib/media-resolve.js";
import {
  resolveVisibleLastBulk,
  type VisibilitySource,
} from "./last-visible-resolver.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { PrivateMessageRepository } from "../repositories/private-message.repository.js";
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
    private readonly privateMessageRepo: PrivateMessageRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService,
    private readonly userServiceClient: UserServiceClient,
    private readonly redis: Redis | Cluster
  ) {}

  /**
   * Adapter exposing the private-message deletion shape (isDeleted + deletedFor
   * MAP) to the shared LastVisibleResolver. PrivateMessage carries no senderName,
   * so the normalized senderName is "" (the list resolves the peer label itself).
   */
  private visibilitySource(): VisibilitySource {
    return {
      filterHidden: (ids, userId) =>
        this.privateMessageRepo.filterHiddenFromUser(ids, userId),
      findPreviousVisibleForUser: async (roomId, userId) => {
        const m = await this.privateMessageRepo.findPreviousVisibleForUser(
          roomId,
          userId
        );
        return m
          ? {
              messageId: m.id,
              senderId: m.senderId ?? "",
              senderName: "",
              messageType: m.messageType,
              content: m.content,
              createdAt: m.createdAt,
            }
          : null;
      },
    };
  }

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

    // Per-user lastMessage visibility pass (via the shared LastVisibleResolver):
    // The shared lastMessageId on each room may point to a message the requesting
    // user deleted for themselves. The resolver batch-checks which shared last
    // ids are hidden (isDeleted OR deletedFor[userId] exists) and concurrently
    // resolves the previous-visible message for ONLY those rooms (typically 0).
    const overrides = await resolveVisibleLastBulk(
      this.visibilitySource(),
      rooms.map((r) => ({
        roomId: r.roomId,
        sharedLastMessageId: r.lastMessageId,
      })),
      userId
    );
    // Normalize the resolver's VisibleLast into the PrivateRoom.lastMessage JSON
    // shape so the wire response is unchanged; key absent => use shared snapshot.
    const perUserFallback = new Map<
      string,
      PrivateRoom["lastMessage"] | null
    >();
    for (const [roomId, prev] of overrides) {
      perUserFallback.set(
        roomId,
        prev
          ? ({
              content: prev.content,
              senderId: prev.senderId,
              messageType: prev.messageType,
              createdAt: prev.createdAt.toISOString(),
            } as unknown as PrivateRoom["lastMessage"])
          : null
      );
    }

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

      // Use per-user fallback if the shared lastMessage is hidden for this user.
      const rawLm = perUserFallback.has(room.roomId)
        ? (perUserFallback.get(room.roomId) ?? null)
        : room.lastMessage;
      const lastMessage = (rawLm && typeof rawLm === "object"
        ? toWireMessage(rawLm as { messageType?: string | null })
        : (rawLm ?? null)) as unknown as PrivateRoom["lastMessage"];

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
