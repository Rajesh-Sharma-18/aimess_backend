import { ForbiddenError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import { MEDIA_PREFIXES, toMediaObject } from "@aimess/storage";
import type { MediaObject } from "@aimess/shared-types";
import type { Redis, Cluster } from "ioredis";

import { buildParticipantsKey, generateRoomId } from "../lib/room-id.js";
import {
  toWireMessage,
  normalizeMessageType,
} from "../lib/chat-message.serializer.js";
import { convertMessageToPreview } from "./message-preview.service.js";
import { resolveMediaUrlMap, urlFromMap } from "../lib/media-resolve.js";
import { mediaUrlStrategy } from "../config/storage.js";
import { env } from "../config/env.js";
import {
  resolveVisibleLastBulk,
  type VisibilitySource,
} from "./last-visible-resolver.js";
import { privateVisibilitySource } from "./last-visible-adapters.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { PrivateMessageRepository } from "../repositories/private-message.repository.js";
import type { UserServiceClient } from "../grpc/user.client.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import {
  resolveDisplayName,
  type UserSnapshotService,
} from "./user-snapshot.service.js";
import type { PresenceService } from "./presence.service.js";
import type { PrivateRoom } from "../generated/prisma/index.js";
import type { ChatFriendshipInfo } from "../grpc/user-snapshot.client.js";

const NONE_RELATIONSHIP: ChatFriendshipInfo = {
  status: "NONE",
  direction: null,
  friendshipId: null,
  requesterId: null,
  canAccept: false,
  canReject: false,
  canCancel: false,
};

/**
 * Wire shape of the top-level `friendship` field — preserved verbatim from the
 * pre-existing contract ({status, direction}) so clients that already read it
 * keep working.
 */
export type WireFriendship = {
  status: "FRIEND" | "PENDING" | "NONE" | "BLOCKED";
  direction: "OUTGOING" | "INCOMING" | null;
};

function toWireFriendship(info: ChatFriendshipInfo): WireFriendship {
  return { status: info.status, direction: info.direction };
}

/**
 * User-search-shaped relationship contract (`GET /api/v1/users/search`) that
 * private-chat responses reuse verbatim on the peer participant of a private
 * room. Mirrors `SearchUserItem` / `PeerRelationship` in user-service. BLOCKED
 * collapses to NONE here (search vocabulary) — the existing `friendship` field
 * on the same response still surfaces the raw BLOCKED state for send-gate use.
 */
export type PeerFriendshipRelationship = {
  isFriend: boolean;
  relationshipStatus: "FRIEND" | "PENDING" | "NONE";
  friendshipId: string | null;
  requesterId: string | null;
  relationship: {
    status: "FRIEND" | "PENDING" | "NONE";
    direction: "OUTGOING" | "INCOMING" | null;
    canAccept: boolean;
    canReject: boolean;
    canCancel: boolean;
  };
};

/**
 * Turns the chat-service `ChatFriendshipInfo` (from user-service gRPC) into
 * the flat user-search-shaped fields — same rules as user-service's
 * `toSearchRelationship`, so search REST and private-chat REST agree on
 * every peer's isFriend/relationshipStatus/friendshipId/requesterId/relationship.
 */
export function toPeerFriendshipRelationship(
  info: ChatFriendshipInfo
): PeerFriendshipRelationship {
  const searchStatus: "FRIEND" | "PENDING" | "NONE" =
    info.status === "FRIEND"
      ? "FRIEND"
      : info.status === "PENDING"
        ? "PENDING"
        : "NONE";
  return {
    isFriend: info.status === "FRIEND",
    relationshipStatus: searchStatus,
    friendshipId: info.friendshipId ?? null,
    requesterId: info.requesterId ?? null,
    relationship: {
      status: searchStatus,
      direction: info.direction,
      canAccept: info.canAccept ?? false,
      canReject: info.canReject ?? false,
      canCancel: info.canCancel ?? false,
    },
  };
}

const AVATAR_PREFIXES = MEDIA_PREFIXES.userAvatars;

/**
 * Build the additive nested {@link MediaObject} for a peer's avatar from the
 * RAW stored object key — mirrors community-service's `buildAvatarMedia` so
 * private-chat and community list items expose an identical avatar shape.
 */
function buildAvatarMedia(
  stored: string | null | undefined
): Promise<MediaObject> {
  return toMediaObject({
    bucket: env.MINIO_BUCKET_AVATARS,
    stored: stored ?? null,
    prefixes: AVATAR_PREFIXES,
    strategy: mediaUrlStrategy,
  });
}

export interface PrivateRoomPeer {
  id: string;
  displayName: string;
  memberId: string;
  /** Nested media object for the peer avatar — mirrors community's `avatar` MediaObject. */
  avatar: MediaObject;
  /** Flattened presigned URL (additive; mirrors community's `avatarUrl`). */
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  isDeletedUser: boolean;
  isOnline: boolean;
}

/**
 * Normalized last-activity DTO for the conversation list — same shape as
 * community's `CommunityLastActivity` (`type`/`userId`/`username`/`preview`/
 * `dateTime`) so both list items render identically on the client.
 */
export interface PrivateConversationLastActivity {
  type: "message";
  userId: string | null;
  username: string;
  preview: string;
  dateTime: number;
}

export type EnrichedPrivateRoom = PrivateRoom & {
  isMuted: boolean;
  peerId: string;
  peer: PrivateRoomPeer;
  /** Epoch-ms mirror of lastMessageAt (community-style: always a number, never null/Date). */
  lastActivityAt: number;
  lastActivity: PrivateConversationLastActivity;
  /** Caller's own unread count, resolved from unreadCountByUser (community-style single int). */
  unreadMessageCount: number;
  /** Live friendship state from user-service — never the local send-gate read-model. */
  friendship: ChatFriendshipInfo;
};

/**
 * `GET /chat/private/conversations` wire item — trims {@link EnrichedPrivateRoom}
 * down to the lean, community-`listMine`-style shape: only the fields with a
 * direct community-list-item equivalent (identifier, other-party info, unread
 * count, normalized last activity, mute state). Drops internal-only per-user
 * maps (mutedBy/archivedBy/deletedFor/lastReadAtByUser/unreadCountByUser/etc.)
 * and redundant duplicate representations (raw `lastMessage`, `lastMessageAt`,
 * internal `id`, `createdAt`/`updatedAt`, `pinnedCount`) that community's list
 * item does not carry either — `lastActivity`/`lastActivityAt` are the single
 * source of truth for "what happened last and when". The peer's fields are
 * flattened onto the item directly (no nested `peer` object).
 */
export interface PrivateConversationListItem extends PeerFriendshipRelationship {
  roomId: string;
  participants: string[];
  peerId: string;
  displayName: string;
  memberId: string;
  avatar: MediaObject;
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  isDeletedUser: boolean;
  isOnline: boolean;
  /** True when the peer is offline — negation of isOnline, from the existing presence pipeline. */
  isOffline: boolean;
  unreadMessageCount: number;
  lastActivityAt: number;
  lastActivity: PrivateConversationLastActivity;
  isMuted: boolean;
  friendship: WireFriendship;
}

function toConversationListItem(
  room: EnrichedPrivateRoom
): PrivateConversationListItem {
  return {
    roomId: room.roomId,
    participants: room.participants,
    peerId: room.peer.id,
    displayName: room.peer.displayName,
    memberId: room.peer.memberId,
    avatar: room.peer.avatar,
    avatarUrl: room.peer.avatarUrl,
    avatarUrlExpiresIn: room.peer.avatarUrlExpiresIn,
    isDeletedUser: room.peer.isDeletedUser,
    isOnline: room.peer.isOnline,
    isOffline: !room.peer.isOnline,
    unreadMessageCount: room.unreadMessageCount,
    lastActivityAt: room.lastActivityAt,
    lastActivity: room.lastActivity,
    isMuted: room.isMuted,
    friendship: toWireFriendship(room.friendship),
    ...toPeerFriendshipRelationship(room.friendship),
  };
}

/**
 * `GET /chat/private/rooms/{peerId}` wire shape — aligned with community's
 * `CommunityData` (`id`/`avatar`/`isMuted`/`muteUntil`/`createdAt`/`updatedAt`
 * use the same field names) plus the private-chat-specific `user`/presence
 * fields. Timestamps are epoch ms (private-chat convention), not the ISO
 * strings community uses.
 */
export interface PrivateRoomDetailsData {
  id: string;
  roomId: string;
  participants: string[];
  peerId: string;
  user: {
    id: string;
    displayName: string;
    memberId: string;
    isDeletedUser: boolean;
  };
  avatar: MediaObject;
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  isOnline: boolean;
  /** True when the peer is offline — negation of isOnline, from the existing presence pipeline. */
  isOffline: boolean;
  isMuted: boolean;
  muteUntil: number | null;
  unreadMessageCount: number;
  lastActivityAt: number;
  lastActivity: PrivateConversationLastActivity;
  createdAt: number;
  updatedAt: number;
  friendship: WireFriendship;
}

/** Response envelope for `listMine` — identical {pagination,data} shape as community's `listMine` (no top-level duplicate hasMore/nextCursor). */
export interface ConversationListPage {
  pagination: {
    totalData: number;
    totalPage: number;
    currentPage: number;
    limit: number;
    nextCursor: string | null;
    hasMore: boolean;
  };
  data: PrivateConversationListItem[];
}

export class PrivateRoomService {
  constructor(
    private readonly privateRoomRepo: PrivateRoomRepository,
    private readonly privateMessageRepo: PrivateMessageRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService,
    private readonly userServiceClient: UserServiceClient,
    private readonly redis: Redis | Cluster,
    // ponytail: optional — omitted in existing unit tests; peer isOnline just
    // falls back to false (matches the pre-existing hardcoded-false behavior).
    private readonly presenceService?: PresenceService,
    // ponytail: optional — omitted in existing unit tests; friendship just
    // falls back to NONE (fail-open on display metadata, same as presence).
    private readonly friendshipGrpcClient?: {
      checkFriendships(
        callerId: string,
        candidateIds: string[]
      ): Promise<Map<string, ChatFriendshipInfo>>;
    }
  ) {}

  /**
   * Adapter exposing the private-message deletion shape (isDeleted + deletedFor
   * MAP) to the shared LastVisibleResolver. PrivateMessage carries no senderName,
   * so the normalized senderName is "" (the list resolves the peer label itself).
   */
  private visibilitySource(): VisibilitySource {
    return privateVisibilitySource(this.privateMessageRepo);
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

  /**
   * `GET /chat/private/rooms/{peerId}` — room details, community-`getById`-aligned.
   * Reuses `getOrCreateRoom` (get-or-create + friendship gate) and `enrichConversations`
   * (peer snapshot, avatar, presence) rather than duplicating either.
   *
   * NOTE: this get-or-CREATES. Friendship is only ever checked here, at
   * first-contact room creation — see {@link getOrCreateRoom}. Once a room
   * exists, {@link toRoomDetailsData}/{@link enrichConversations} never
   * re-check it: private room and friendship are independent concepts, so an
   * existing room + its history survive unfriend/reject/cancel/block. Use
   * {@link getRoomDetailsById} for a pure, non-creating lookup by the room's
   * own id.
   */
  async getRoomDetails(
    userId: string,
    peerId: string
  ): Promise<PrivateRoomDetailsData> {
    const room = await this.getOrCreateRoom(userId, peerId);
    const [enriched] = await this.enrichConversations([room], userId);
    return this.toRoomDetailsData(enriched, userId);
  }

  /**
   * `GET /chat/private/rooms/{roomId}` — room details by the room's OWN id
   * (format `prv_<id>`, see `lib/room-id.ts`), as opposed to {@link
   * getRoomDetails}'s by-peer-id get-or-create. Pure read: never creates a
   * room, and — critically — never gates on friendship. A private room
   * outlives the friendship that (maybe) started it, so this is the correct
   * entry point for "does this room still exist / what's the room + current
   * friendship state" once a roomId is already known to the caller (e.g. from
   * the conversation list or a deep link) — friendship changes (unfriend,
   * reject, cancel, block) never hide the room or its history, only the
   * returned `friendship` field reflects the current state.
   *
   * @throws NotFoundError `CHAT_ROOM_NOT_FOUND` when the room doesn't exist,
   *   OR the caller isn't one of its participants (anti-enumeration — same
   *   404, not 403, as {@link deleteForMe}/{@link muteRoom}).
   */
  async getRoomDetailsById(
    userId: string,
    roomId: string
  ): Promise<PrivateRoomDetailsData> {
    const room = await this.privateRoomRepo.findByRoomId(roomId);
    if (!room || !room.participants?.includes(userId)) {
      throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    }
    const [enriched] = await this.enrichConversations([room], userId);
    return this.toRoomDetailsData(enriched, userId);
  }

  /**
   * The SINGLE builder for the `PrivateRoomDetailsData` wire shape — shared by
   * {@link getRoomDetails} (by-peer, get-or-create) and {@link
   * getRoomDetailsById} (by-room-id, read-only) so both entry points return a
   * byte-identical response built from the same `enrichConversations` output,
   * including the live `friendship` (and, folded into its `status`, current
   * block) state — never computed independently per call site.
   */
  private toRoomDetailsData(
    enriched: EnrichedPrivateRoom,
    userId: string
  ): PrivateRoomDetailsData {
    const mutedBy = (enriched.mutedBy ?? {}) as Record<
      string,
      { muteUntil?: string | null }
    >;
    const myMute = mutedBy[userId];
    const muteUntil = myMute?.muteUntil
      ? new Date(myMute.muteUntil).getTime()
      : null;

    return {
      id: enriched.roomId,
      roomId: enriched.roomId,
      participants: enriched.participants,
      peerId: enriched.peerId,
      user: {
        id: enriched.peer.id,
        displayName: enriched.peer.displayName,
        memberId: enriched.peer.memberId,
        isDeletedUser: enriched.peer.isDeletedUser,
      },
      avatar: enriched.peer.avatar,
      avatarUrl: enriched.peer.avatarUrl,
      avatarUrlExpiresIn: enriched.peer.avatarUrlExpiresIn,
      isOnline: enriched.peer.isOnline,
      isOffline: !enriched.peer.isOnline,
      isMuted: enriched.isMuted,
      muteUntil,
      unreadMessageCount: enriched.unreadMessageCount,
      lastActivityAt: enriched.lastActivityAt,
      lastActivity: enriched.lastActivity,
      createdAt: enriched.createdAt.getTime(),
      updatedAt: enriched.updatedAt.getTime(),
      friendship: toWireFriendship(enriched.friendship),
    };
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
   * `GET /chat/private/conversations` list — cursor (before_ts/after_ts)
   * pagination with an EXACT `hasMore`/`nextCursor`, mirroring community's
   * `listMine` (over-fetch one extra row so `hasMore` never guesses).
   */
  async listMine(
    userId: string,
    params: { direction: "before" | "after"; ts: Date; limit: number }
  ): Promise<ConversationListPage> {
    const [rooms, total] = await Promise.all([
      this.privateRoomRepo.getInboxConversations({
        userId,
        direction: params.direction,
        ts: params.ts,
        limit: params.limit + 1,
      }),
      this.privateRoomRepo.countConversations(userId),
    ]);

    const hasMore = rooms.length > params.limit;
    const pageRows = rooms.slice(0, params.limit);
    const enriched = await this.enrichConversations(pageRows, userId);
    const data = enriched.map(toConversationListItem);

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow?.lastMessageAt
        ? String(lastRow.lastMessageAt.getTime())
        : null;

    return {
      pagination: {
        totalData: total,
        totalPage: Math.ceil(total / params.limit) || 1,
        currentPage: 1,
        limit: params.limit,
        nextCursor,
        hasMore,
      },
      data,
    };
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

    const friendshipByPeer = this.friendshipGrpcClient
      ? await this.friendshipGrpcClient.checkFriendships(userId, peerIds)
      : new Map<string, ChatFriendshipInfo>();

    // Real-time presence — reuses PresenceService (same `presence:user:<id>`
    // Redis source conv:updated reads) rather than the user-snapshot's
    // `isOnline` field, which user-service never populates (always false).
    const onlineByPeer = this.presenceService
      ? await this.presenceService.getPresenceMany(peerIds)
      : new Map<string, boolean>();

    // Resolve peer avatar object keys → full download URLs (resolve on read).
    const avatarUrls = await resolveMediaUrlMap(
      [...snapshots.values()].map(
        (snap) => (snap as Record<string, unknown>).avatar as string
      )
    );
    // Nested MediaObject per peer — community-style avatar shape (additive to
    // the flattened `avatarUrl` above; both derive from the same stored key).
    const avatarMediaByPeer = new Map<string, MediaObject>(
      await Promise.all(
        peerIds.map(
          async (id): Promise<[string, MediaObject]> => [
            id,
            await buildAvatarMedia(
              (snapshots.get(id) as Record<string, unknown> | undefined)
                ?.avatar as string | undefined
            ),
          ]
        )
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

      // Community-style normalized lastActivity — same {type,userId,username,
      // preview,dateTime} shape as CommunityLastActivity. `username` mirrors
      // the sender's live display name (peer if they sent it; empty when the
      // caller sent it themselves — the client already knows its own name and
      // renders "You:", matching how the community list defers self-labeling).
      const lmRecord = rawLm as Record<string, unknown> | null;
      const lmSenderId = (lmRecord?.senderId as string) ?? null;
      const lmMessageType = normalizeMessageType(
        (lmRecord?.messageType as string) ?? "TEXT"
      );
      const lmDateTime = lmRecord?.createdAt
        ? new Date(lmRecord.createdAt as string | Date).getTime()
        : (room.lastMessageAt?.getTime() ?? 0);
      const lastActivityAt = lmDateTime || (room.lastMessageAt?.getTime() ?? 0);
      const lastActivity: PrivateConversationLastActivity = {
        type: "message",
        userId: lmSenderId,
        username:
          lmSenderId && lmSenderId === peerId
            ? (snapshot.displayName as string) || ""
            : "",
        preview: lmRecord
          ? convertMessageToPreview(lmMessageType, lmRecord.content)
          : "",
        dateTime: lastActivityAt,
      };

      const unreadCountByUser = (room.unreadCountByUser ?? {}) as Record<
        string,
        number
      >;

      const avatarMedia = avatarMediaByPeer.get(peerId) ?? ({} as MediaObject);

      return {
        ...room,
        lastMessage,
        isMuted,
        peerId,
        peer: {
          id: peerId,
          displayName: resolveDisplayName(snapshot),
          memberId: (snapshot.memberId as string) || "",
          avatar: avatarMedia,
          avatarUrl:
            urlFromMap(avatarUrls, (snapshot.avatar as string) || "") || null,
          avatarUrlExpiresIn: avatarMedia?.downloadUrlExpiresIn ?? null,
          isDeletedUser: snapshot.isDeletedUser === true,
          isOnline: onlineByPeer.get(peerId) ?? false,
        },
        lastActivityAt,
        lastActivity,
        unreadMessageCount: unreadCountByUser[userId] ?? 0,
        friendship: friendshipByPeer.get(peerId) ?? NONE_RELATIONSHIP,
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
