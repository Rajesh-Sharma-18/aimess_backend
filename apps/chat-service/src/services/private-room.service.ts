import { currentLocale } from "@aimess/constants";
import { BadRequestError, ForbiddenError, NotFoundError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import { MEDIA_PREFIXES, toMediaObject } from "@aimess/storage";
import type { MediaObject } from "@aimess/shared-types";
import type { Redis, Cluster } from "ioredis";

import { listRowIdentity } from "../lib/list-row-identity.js";
import { publishConvUpdatedSafe } from "../events/publish-conv-updated.js";
import { buildParticipantsKey, generateRoomId } from "../lib/room-id.js";
import {
  toWireMessage,
  normalizeMessageType,
} from "../lib/chat-message.serializer.js";
import { convertMessageToPreview } from "./message-preview.service.js";
import { localizedActivityPreview } from "../lib/localize-system-preview.js";
import { resolveMediaUrlMap, urlFromMap } from "../lib/media-resolve.js";
import { mediaUrlStrategy } from "../config/storage.js";
import { env } from "../config/env.js";
import {
  resolveVisibleLastBulk,
  type VisibilitySource,
} from "./last-visible-resolver.js";
import { privateVisibilitySource } from "./last-visible-adapters.js";
import {
  getPrivateDeletionCutoff,
  isHiddenByCutoff,
} from "../lib/deletion-cutoff.js";
import { publishUserReport } from "../lib/report-user.js";
import { filterBannedUserIds } from "@aimess/redis";
import {
  AUTO_DELETE_OFF,
  buildAutoDeleteWire,
  readPolicyVersion,
  readRoomAutoDelete,
  resolveAccountDefaultSetting,
} from "../lib/auto-delete.js";
import { getAccountChatSettings } from "../lib/account-chat-settings.js";
import { foldTickStatus } from "../lib/tick-status.js";
import {
  privateReceiptCursorOf,
  receiptVisibleToViewer,
} from "../lib/read-receipts.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { PrivateMessageRepository } from "../repositories/private-message.repository.js";
import type { UserServiceClient } from "../grpc/user.client.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import {
  resolveDisplayName,
  type UserSnapshotService,
} from "./user-snapshot.service.js";
import type { PresenceService, PresenceView } from "./presence.service.js";
import type { PrivatePinService } from "./private-pin.service.js";
import type { PrivateRoom } from "../generated/prisma/index.js";
import type { ChatFriendshipInfo } from "../grpc/user-snapshot.client.js";

/**
 * Get-or-create the pair's private room and announce it, WITHOUT the friendship
 * gate — the caller is responsible for having established that the two are
 * friends. Extracted from {@link PrivateRoomService.getOrCreateRoom} (which is
 * just this plus the gate) so the friendship consumer can reuse it: the consumer
 * has just written the ACTIVE read-model rows itself, and re-asking
 * `checkFriendship` there would be a pointless gRPC hop.
 */
export async function ensurePrivateRoom(
  deps: {
    privateRoomRepo: PrivateRoomRepository;
    userSnapshotService: UserSnapshotService;
    cacheRepo: CacheRepository;
    redis: Redis | Cluster;
  },
  userId: string,
  peerId: string
): Promise<PrivateRoom> {
  const participantsKey = buildParticipantsKey(userId, peerId);
  const existing =
    await deps.privateRoomRepo.findByParticipantsKey(participantsKey);
  if (existing) return existing;

  // "Default message timer for new private chats" — snapshotted from the
  // INITIATING user's account settings, once, at creation. This is the only
  // moment the account default touches a room: afterwards the room policy is
  // shared and independent, so changing the account default later must not
  // silently rewrite conversations the peer also participates in. Fails OPEN
  // (no timer) — a settings lookup must never block opening a chat.
  const accountDefault = await getAccountChatSettings(userId)
    .then(resolveAccountDefaultSetting)
    .catch(() => AUTO_DELETE_OFF);

  const roomId = generateRoomId("prv");
  const room = await deps.privateRoomRepo.create({
    roomId,
    participants: [userId, peerId].sort(),
    participantsKey,
    ...(accountDefault.mode === "OFF"
      ? {}
      : {
          autoDelete: {
            mode: accountDefault.mode,
            ttlSeconds: accountDefault.ttlSeconds,
            setAt: new Date().toISOString(),
            setBy: userId,
          },
        }),
  });

  logger.debug(`PrivateRoomService|ensurePrivateRoom|created room=${roomId}`);

  // Notify both participants that a new conversation was opened.
  //
  // ADDITIVE `peer`: the recipient's OWN view of the other participant. Without it a client can
  // only learn the peer's name from `GET /chat/inbox`, which keysets on `lastMessageAt` and
  // therefore never returns a room that has no messages yet — a chat created by accepting a
  // friend request showed a nameless row until the first message. Existing clients ignore the
  // extra field; the `participants` array and every other field are unchanged.
  const snapshots = await deps.userSnapshotService
    .getUserSnapshotsMap([userId, peerId], deps.cacheRepo)
    .catch(() => new Map<string, Record<string, unknown>>());
  const briefFor = (id: string) => ({
    id,
    displayName: resolveDisplayName(snapshots.get(id)),
    memberId: (snapshots.get(id)?.memberId as string) || "",
  });
  const convCreatedFor = (recipientId: string, otherId: string) =>
    JSON.stringify({
      event: "conv:created",
      data: {
        roomId,
        participants: [userId, peerId],
        peer: briefFor(otherId),
      },
    });
  deps.redis
    .publish(`user:${userId}`, convCreatedFor(userId, peerId))
    .catch(() => {});
  deps.redis
    .publish(`user:${peerId}`, convCreatedFor(peerId, userId))
    .catch(() => {});

  return room;
}

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
  /**
   * The peer was permanently banned from the platform by a super admin. The DM
   * keeps its history and stays in the list, but every write is refused with
   * `CHAT_PEER_BANNED` — the client renders a banner + disabled composer.
   * Treated exactly like `isDeletedUser` for presence and friendship actions.
   */
  isBanned: boolean;
  isOnline: boolean;
  /** Server-generated epoch ms. Meaningful only while `isOnline` is false. */
  lastSeen: number | null;
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
  /**
   * Offline-first identity/freshness quartet + the canonical content type,
   * mirroring `CommunityLastActivity`. ADDITIVE — `PrivateConversationListItem`
   * drops the raw `lastMessage`, so without these the private conversation list
   * carries no message identity at all and a client can only compare
   * timestamps. `messageId` is "" and `seq`/`revision` 0 when the row has no
   * visible last message (or was written before this field existed).
   */
  messageId: string;
  clientMessageId: string | null;
  seq: number;
  revision: number;
  /** UPPER-CASE canonical content type (TEXT/IMAGE/…/SYSTEM). */
  contentType: string;
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
  /**
   * Telegram/WhatsApp-style tick for the last message, but ONLY meaningful when
   * the CALLER sent it (null otherwise — no tick to show on a peer's message).
   * DELIVERED/READ are resolved from real persisted state: `PrivateMessage.deliveredTo`
   * (written by markDeliveredUpTo) and the peer's `lastReadMessageIdByUser` cursor
   * (the real read source of truth — `PrivateMessage.readBy` is dead/unpopulated).
   */
  lastMessageReadStatus: "SENT" | "DELIVERED" | "READ" | null;
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
  /** Peer permanently banned by a super admin — see `PrivateRoomPeer.isBanned`. */
  isBanned: boolean;
  isOnline: boolean;
  /** True when the peer is offline — negation of isOnline, from the existing presence pipeline. */
  isOffline: boolean;
  /** Server-generated epoch ms. Meaningful only while `isOnline` is false. */
  lastSeen: number | null;
  unreadMessageCount: number;
  lastActivityAt: number;
  lastActivity: PrivateConversationLastActivity;
  isMuted: boolean;
  friendship: WireFriendship;
  lastMessageReadStatus: "SENT" | "DELIVERED" | "READ" | null;
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
    isBanned: room.peer.isBanned,
    isOnline: room.peer.isOnline,
    isOffline: !room.peer.isOnline,
    lastSeen: room.peer.lastSeen,
    unreadMessageCount: room.unreadMessageCount,
    lastActivityAt: room.lastActivityAt,
    lastActivity: room.lastActivity,
    isMuted: room.isMuted,
    friendship: toWireFriendship(room.friendship),
    lastMessageReadStatus: room.lastMessageReadStatus,
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
export interface PrivateRoomDetailsData extends PeerFriendshipRelationship {
  id: string;
  roomId: string;
  participants: string[];
  peerId: string;
  user: {
    id: string;
    displayName: string;
    memberId: string;
    isDeletedUser: boolean;
    /** Peer permanently banned by a super admin — see `PrivateRoomPeer.isBanned`. */
    isBanned: boolean;
  };
  avatar: MediaObject;
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  isOnline: boolean;
  /** True when the peer is offline — negation of isOnline, from the existing presence pipeline. */
  isOffline: boolean;
  /** Server-generated epoch ms. Meaningful only while `isOnline` is false. */
  lastSeen: number | null;
  isMuted: boolean;
  muteUntil: number | null;
  unreadMessageCount: number;
  lastActivityAt: number;
  lastActivity: PrivateConversationLastActivity;
  createdAt: number;
  updatedAt: number;
  friendship: WireFriendship;
  /** Auto-delete (disappearing messages) state — see lib/auto-delete.ts#buildAutoDeleteWire. */
  autoDelete: Record<string, unknown>;
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
    },
    // ponytail: optional — omitted in existing unit tests; pin clearing on
    // delete just becomes a no-op (matches the pre-existing behavior).
    private readonly pinService?: PrivatePinService
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
    const existing = await this.privateRoomRepo.findByParticipantsKey(
      buildParticipantsKey(userId, peerId)
    );
    if (existing) return existing;

    const friends = await this.userServiceClient.checkFriendship(
      userId,
      peerId
    );
    if (!friends) {
      throw new ForbiddenError("CHAT_FRIENDSHIP_REQUIRED");
    }

    return ensurePrivateRoom(
      {
        privateRoomRepo: this.privateRoomRepo,
        userSnapshotService: this.userSnapshotService,
        cacheRepo: this.cacheRepo,
        redis: this.redis,
      },
      userId,
      peerId
    );
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
  private async toRoomDetailsData(
    enriched: EnrichedPrivateRoom,
    userId: string
  ): Promise<PrivateRoomDetailsData> {
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
        isBanned: enriched.peer.isBanned,
      },
      avatar: enriched.peer.avatar,
      avatarUrl: enriched.peer.avatarUrl,
      avatarUrlExpiresIn: enriched.peer.avatarUrlExpiresIn,
      isOnline: enriched.peer.isOnline,
      isOffline: !enriched.peer.isOnline,
      lastSeen: enriched.peer.lastSeen,
      isMuted: enriched.isMuted,
      muteUntil,
      unreadMessageCount: enriched.unreadMessageCount,
      lastActivityAt: enriched.lastActivityAt,
      lastActivity: enriched.lastActivity,
      createdAt: enriched.createdAt.getTime(),
      updatedAt: enriched.updatedAt.getTime(),
      friendship: toWireFriendship(enriched.friendship),
      autoDelete: buildAutoDeleteWire(readRoomAutoDelete(enriched), {
        conversationType: "PRIVATE",
        policyVersion: readPolicyVersion(enriched),
        // Either participant may change a private conversation's timer.
        canEdit: true,
      }),
      ...toPeerFriendshipRelationship(enriched.friendship),
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
    /** V2 compound-cursor tiebreaker; omitted on V1 (inclusive bare-ts bound). */
    boundaryId?: string | null;
    inclusive?: boolean;
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

    // Fetch the caller's own snapshot alongside the peers' — community-style
    // lastActivity always carries the ACTUAL sender's live name (self included),
    // never an empty placeholder; the client alone decides "You:" vs "<name>:".
    const snapshots = await this.userSnapshotService.getUserSnapshotsMap(
      [...peerIds, userId],
      this.cacheRepo
    );
    const myDisplayName = resolveDisplayName(snapshots.get(userId));

    const friendshipByPeer = this.friendshipGrpcClient
      ? await this.friendshipGrpcClient.checkFriendships(userId, peerIds)
      : new Map<string, ChatFriendshipInfo>();

    // Real-time presence — reuses PresenceService (the same canonical Redis
    // state `presence:status` is published from) rather than the user-snapshot's
    // `isOnline` field, which user-service never populates (always false).
    // Viewer-scoped: a peer whose `whoCanSeeOnlineStatus` excludes this caller
    // reads as offline here, exactly as they do on every other surface.
    //
    // `lastSeen` rides along because this response IS the client's presence
    // hydration: a conversation opened while the peer is already offline must
    // render "Last seen …" immediately, and no further `presence:status` is
    // coming (nothing changed) to supply it.
    const presenceByPeer = this.presenceService
      ? await this.presenceService.getPresenceViewsFor(userId, peerIds)
      : new Map<string, PresenceView>();

    // One MGET for the whole page — the snapshot's `isDeletedUser` has a 1h
    // cache and cannot carry this. Fails OPEN (no banner) on a Redis error, the
    // same policy the write-side guard uses.
    const bannedPeers = await filterBannedUserIds(this.redis, peerIds).catch(
      () => new Set<string>()
    );

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
              ...listRowIdentity({ ...prev, id: prev.messageId }),
            } as unknown as PrivateRoom["lastMessage"])
          : null
      );
    }

    // Own-last-message read/delivery tick (Telegram/WhatsApp parity) — batch-resolved
    // once for the whole page. Uses the SAME rawLm each row's lastActivity below is
    // built from, so a delete-for-me override is respected. Only computed for rows
    // where the CALLER sent the (viewer-visible) last message.
    const idsToResolve = new Set<string>();
    const ownRowMeta = new Map<
      string,
      {
        lastMessageId: string;
        peerReadCursorId: string | null;
        peerReadAt: Date | null;
        peerId: string;
      }
    >();
    for (const room of rooms) {
      const rawLmForStatus = perUserFallback.has(room.roomId)
        ? (perUserFallback.get(room.roomId) ?? null)
        : room.lastMessage;
      const lmSenderId = (rawLmForStatus as Record<string, unknown> | null)
        ?.senderId as string | undefined;
      // A SYSTEM line (friendship created, auto-delete notice, ...) carries the
      // acting user's id but is not a user-sent message, so it must never get a
      // delivery/read tick — even though the "I sent it" test below passes.
      const lmType = String(
        (rawLmForStatus as Record<string, unknown> | null)?.messageType ?? ""
      ).toUpperCase();
      // A cleared / delete-conversation cutoff hides the message from this
      // viewer entirely, so it must not carry a delivery/read tick either —
      // otherwise an emptied row still renders a ✓✓ for a message it no longer
      // shows. Same cutoff the preview below applies.
      const statusCutoff = getPrivateDeletionCutoff(room, userId);
      const lmCreatedAt = (rawLmForStatus as Record<string, unknown> | null)
        ?.createdAt as string | Date | undefined;
      const hiddenForStatus = isHiddenByCutoff(lmCreatedAt, statusCutoff);
      if (
        lmSenderId !== userId ||
        !room.lastMessageId ||
        lmType === "SYSTEM" ||
        hiddenForStatus
      )
        continue;
      const peerId = (room.participants || []).find((p) => p !== userId) || "";
      // The EXPOSABLE pointer (frozen while the peer's receipts are off), never
      // the plain read one — see `privateReceiptCursorOf`.
      const peerCursor = privateReceiptCursorOf(room, peerId);
      const peerReadCursorId = peerCursor.messageId;
      ownRowMeta.set(room.roomId, {
        lastMessageId: room.lastMessageId,
        peerReadCursorId,
        peerReadAt: peerCursor.readAt,
        peerId,
      });
      idsToResolve.add(room.lastMessageId);
      if (peerReadCursorId) idsToResolve.add(peerReadCursorId);
    }
    const resolvedMessages = idsToResolve.size
      ? await this.privateMessageRepo.findManyByIds([...idsToResolve])
      : [];
    const messageById = new Map(resolvedMessages.map((m) => [m.id, m]));

    // Settings → Chat → Read Receipt, applied to the LIST tick as well as the
    // live `message:read` event — otherwise the blue tick the socket withheld
    // reappears on the next refresh and the switch looks broken. Reciprocal,
    // WhatsApp-style: the viewer must allow receipts to SEE one, and the peer
    // must allow receipts to GIVE one. Cached per user, so this is at most one
    // lookup per distinct peer on the page.
    const viewerSettings = await getAccountChatSettings(userId);
    const viewerSeesReceipts = viewerSettings.readReceipts;
    const receiptPeerIds = [
      ...new Set([...ownRowMeta.values()].map((m) => m.peerId).filter(Boolean)),
    ];
    const peerGivesReceipts = new Map(
      await Promise.all(
        receiptPeerIds.map(
          async (id) =>
            [id, (await getAccountChatSettings(id)).readReceipts] as const
        )
      )
    );

    const readStatusByRoom = new Map<string, "SENT" | "DELIVERED" | "READ">();
    for (const [roomId, meta] of ownRowMeta) {
      const lastMsg = messageById.get(meta.lastMessageId) as
        | { sequenceNumber?: number; deliveredTo?: unknown[] }
        | undefined;
      const lastSeq = lastMsg?.sequenceNumber ?? 0;
      const peerReadSeq = meta.peerReadCursorId
        ? ((
            messageById.get(meta.peerReadCursorId) as
              | { sequenceNumber?: number }
              | undefined
          )?.sequenceNumber ?? 0)
        : 0;
      const receiptsVisible =
        viewerSeesReceipts &&
        peerGivesReceipts.get(meta.peerId) !== false &&
        // A receipt that predates this viewer's own OFF → ON switch was
        // withheld from them while it was off and stays withheld: flipping the
        // switch is a policy change, not a read event.
        receiptVisibleToViewer(
          viewerSettings.readReceiptsEnabledAt,
          meta.peerReadAt
        );
      // Same fold the chatroom bubble runs (`foldTickStatus`), fed the same
      // settings-gated peer watermark the history endpoint hands the client as
      // `peerReadSeq` — one message can no longer resolve to two ticks.
      // The peer appearing in the last message's `deliveredTo` IS
      // "peerDeliveredSeq >= lastSeq"; `markDeliveredUpTo` never lists the
      // sender, so anyone in there is the peer.
      readStatusByRoom.set(
        roomId,
        foldTickStatus({
          seq: lastSeq,
          otherCount: 1,
          readSeqs: receiptsVisible ? [peerReadSeq] : [],
          deliveredSeqs: (lastMsg?.deliveredTo ?? []).length ? [lastSeq] : [],
        })
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
      const cutoff = getPrivateDeletionCutoff(room, userId);
      const rawLmDate = (rawLm as Record<string, unknown> | null)?.createdAt as
        | string
        | Date
        | undefined;
      const hiddenByCutoff = isHiddenByCutoff(rawLmDate, cutoff);
      const visibleRawLm = hiddenByCutoff ? null : rawLm;
      // "This viewer has NOTHING visible left in this room" — either their
      // clear/delete-conversation cutoff swallowed the last message, or the
      // per-user resolver walked back and found no previous-visible message.
      // Distinct from "the shared lastMessage JSON is missing on a legacy row",
      // which must keep falling back to the stored lastMessageAt below.
      const nothingVisible =
        hiddenByCutoff ||
        (perUserFallback.has(room.roomId) && !perUserFallback.get(room.roomId));
      const lastMessage = (visibleRawLm && typeof visibleRawLm === "object"
        ? toWireMessage(visibleRawLm as { messageType?: string | null })
        : (visibleRawLm ?? null)) as unknown as PrivateRoom["lastMessage"];

      // Community-style normalized lastActivity — same {type,userId,username,
      // preview,dateTime} shape as CommunityLastActivity. `username` mirrors
      // the sender's live display name (peer if they sent it; empty when the
      // caller sent it themselves — the client already knows its own name and
      // renders "You:", matching how the community list defers self-labeling).
      const lmRecord = visibleRawLm as Record<string, unknown> | null;
      const lmSenderId = (lmRecord?.senderId as string) ?? null;
      const lmMessageType = normalizeMessageType(
        (lmRecord?.messageType as string) ?? "TEXT"
      );
      const lmDateTime = lmRecord?.createdAt
        ? new Date(lmRecord.createdAt as string | Date).getTime()
        : 0;
      // The EFFECTIVE (per-viewer) activity timestamp. When the viewer has no
      // visible message left it MUST be 0 — falling back to the shared
      // `room.lastMessageAt` here is what used to leave a cleared/emptied chat
      // pinned at the top of the list with an empty preview but the timestamp of
      // the very message the viewer just removed.
      const lastActivityAt = nothingVisible
        ? 0
        : lmDateTime || (room.lastMessageAt?.getTime() ?? 0);
      // Always carry the ACTUAL sender's live name — self included — mirroring
      // community's buildLastActivity. Previously this was forced empty when the
      // caller sent the message, and the client filled the gap by falling back to
      // `peer.displayName`, which showed the PEER's (or, via a stale/live-bump
      // mismatch, the WRONG party's) name instead of "You:". The client alone
      // decides the "You:" vs "<name>:" prefix from `userId === myUserId`.
      const lastActivity: PrivateConversationLastActivity = {
        type: "message",
        userId: lmSenderId,
        username: lmSenderId
          ? lmSenderId === peerId
            ? resolveDisplayName(snapshot)
            : myDisplayName
          : "",
        // A SYSTEM snapshot's preview is the sentence baked in at write time
        // (English); re-render it from the snapshot's own systemEvent/systemData
        // in this reader's language, exactly as the transcript does. Non-SYSTEM
        // previews are returned untouched.
        preview: lmRecord
          ? localizedActivityPreview(
              convertMessageToPreview(
                lmMessageType,
                lmRecord.content,
                currentLocale()
              ),
              {
                messageType: lmMessageType,
                systemEvent: lmRecord.systemEvent as string | null,
                systemData: lmRecord.systemData,
              },
              "PRIVATE",
              userId
            )
          : "",
        dateTime: lastActivityAt,
        // Identity/freshness quartet — read off the same snapshot the preview
        // came from, so an override (delete-for-me fallback) and the shared
        // snapshot both describe the message actually being previewed.
        ...listRowIdentity({
          id: (lmRecord?.messageId as string) ?? room.lastMessageId ?? "",
          clientMessageId: (lmRecord?.clientMessageId as string) ?? null,
          sequenceNumber: (lmRecord?.seq as number) ?? 0,
          revision: (lmRecord?.revision as number) ?? 0,
        }),
        contentType: lmRecord ? lmMessageType : "",
      };

      // Reaction OVERLAY read-time gate (mirrors community-service's listMine
      // reconciliation): visible ONLY to its own actor and (if different) the
      // reacted-to message's owner, and ONLY while it's strictly newer than the
      // canonical lastActivity — a genuinely newer message silently supersedes a
      // stale reaction with no explicit clear needed. Every other viewer (never
      // more than one "other" here, since PRIVATE has exactly 2 participants)
      // keeps the real last message untouched.
      //
      // The cutoff gate is the SAME one the preview above applies: a reaction
      // that landed at/before the viewer's clear is part of the history they
      // emptied. Without it the overlay walked straight past `nothingVisible`
      // (which forces `lastActivityAt` to 0, so *any* stored reaction compared
      // as "newer") and re-rendered "You reacted 🔥 to …" — with the old
      // timestamp — on a chat the viewer had just cleared.
      // ponytail: gates on the reaction's OWN time only. A reaction made AFTER
      // the clear still previews, even though its target message is below the
      // cutoff; hiding that too needs the target's createdAt, i.e. a per-row
      // message lookup.
      if (
        room.reactionActivityAt &&
        room.reactionActivityAt.getTime() > lastActivityAt &&
        !isHiddenByCutoff(room.reactionActivityAt, cutoff)
      ) {
        const isActor = room.reactionActivityActorId === userId;
        const isTarget = room.reactionActivityTargetId === userId;
        if (isActor || isTarget) {
          lastActivity.type = "message";
          lastActivity.userId = room.reactionActivityActorId;
          lastActivity.username = "";
          lastActivity.preview = isActor
            ? (room.reactionActivityActorPreview ?? "")
            : (room.reactionActivityTargetPreview ?? "");
          // `dateTime` deliberately keeps the canonical value: the overlay
          // replaces the row's PREVIEW TEXT and nothing else (the same rule
          // GroupRoomService.applyReactionOverlay already states). The inbox is
          // ordered off this timestamp, and a reaction is not conversation
          // activity — advancing it re-sorted the row to the top of the list on
          // every reaction and on every refetch after one.
          // The overlay is an ACTIVITY LINE, not a message — clear the message
          // identity so a client merging by identity never mistakes it for an
          // edit of whatever message it is temporarily covering.
          lastActivity.messageId = "";
          lastActivity.clientMessageId = null;
          lastActivity.seq = 0;
          lastActivity.revision = 0;
          lastActivity.contentType = "SYSTEM";
        }
      }

      const unreadCountByUser = (room.unreadCountByUser ?? {}) as Record<
        string,
        number
      >;

      const avatarMedia = avatarMediaByPeer.get(peerId) ?? ({} as MediaObject);

      // One peer object feeds BOTH the conversation list and the room-details
      // header, so the deleted-account rules only have to be applied here.
      const isDeletedPeer = snapshot.isDeletedUser === true;
      // A system-banned peer is inert in exactly the same ways as a deleted
      // one: no presence to report, no friendship action that can succeed.
      const isBannedPeer = bannedPeers.has(peerId);
      const isInertPeer = isDeletedPeer || isBannedPeer;

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
          isDeletedUser: isDeletedPeer,
          isBanned: isBannedPeer,
          // A deleted account has no presence to report. Its sockets were
          // force-dropped at deletion so `isOnline` is already false in
          // practice, but `lastSeen` outlives that in Redis and would keep
          // rendering "Last seen 3 minutes ago" under a Deleted Account header.
          isOnline: isInertPeer
            ? false
            : (presenceByPeer.get(peerId)?.isOnline ?? false),
          lastSeen: isInertPeer
            ? null
            : (presenceByPeer.get(peerId)?.lastSeen ?? null),
        },
        lastActivityAt,
        lastActivity,
        unreadMessageCount: unreadCountByUser[userId] ?? 0,
        // The status itself stays factual (they ARE still your friend on
        // record, and unfriend cleanup depends on that), but nothing about the
        // relationship is actionable any more — every one of these buttons
        // posts to an endpoint that can only fail against a deleted account.
        friendship: isInertPeer
          ? {
              ...(friendshipByPeer.get(peerId) ?? NONE_RELATIONSHIP),
              canAccept: false,
              canReject: false,
              canCancel: false,
            }
          : (friendshipByPeer.get(peerId) ?? NONE_RELATIONSHIP),
        lastMessageReadStatus: readStatusByRoom.get(room.roomId) ?? null,
      };
    });
  }

  async countConversations(userId: string): Promise<number> {
    return this.privateRoomRepo.countConversations(userId);
  }

  async sumUnreadForUser(userId: string): Promise<number> {
    return this.privateRoomRepo.sumUnreadForUser(userId);
  }

  async deleteForMe(roomId: string, userId: string): Promise<void> {
    const room = await this.privateRoomRepo.findByRoomId(roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");

    const isParticipant = room.participants?.includes(userId);
    if (!isParticipant) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");

    await this.privateRoomRepo.setDeletedFor(roomId, userId);

    // The pin belongs to the room, not either user — clear it so a stale
    // pin doesn't resurface if the room becomes visible again later (e.g.
    // a new message arrives after this delete). Best-effort: must not fail
    // the delete itself.
    const clearedPin = await this.pinService
      ?.clearActivePin(roomId, userId)
      .catch((err: unknown) => {
        logger.warn(
          `PrivateRoomService|deleteForMe: clearActivePin failed: ${String(err)}`
        );
        return null;
      });
    if (clearedPin) {
      this.redis
        .publish(
          `conv:${roomId}`,
          JSON.stringify({
            event: "pin:updated",
            data: {
              roomId,
              conversationId: roomId,
              messageId: clearedPin.messageId,
              unpinnedBy: userId,
              action: "unpinned",
              pinnedCount: 0,
            },
          })
        )
        .catch(() => {});
    }

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

  /**
   * Report the peer of a private conversation — the private-chat counterpart of
   * GroupMemberService.reportMember and community's createReport, going through
   * the same shared {@link publishUserReport} sink.
   *
   * Authorization mirrors those two: the reporter must actually be in the room
   * (never trust the client's roomId), the target must be the room's OTHER
   * participant (so a valid room id can't be used to report an unrelated user),
   * and self-reporting is rejected. Blocking is deliberately NOT a gate — the
   * whole point of reporting is that it survives a hostile peer, and community
   * doesn't gate on it either. Nothing about the peer is returned, so no
   * privacy-masked field can leak through this path.
   */
  async reportUser(params: {
    roomId: string;
    reporterId: string;
    targetUserId: string;
    reason: string;
    description?: string;
  }): Promise<{ ok: true }> {
    if (params.reporterId === params.targetUserId) {
      throw new BadRequestError("CHAT_REPORT_OWN_MESSAGE");
    }

    const room = await this.privateRoomRepo.findByRoomId(params.roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    if (!room.participants?.includes(params.reporterId)) {
      throw new ForbiddenError("CHAT_REPORT_NOT_PARTICIPANT");
    }
    if (!room.participants.includes(params.targetUserId)) {
      throw new NotFoundError("CHAT_REPORT_NOT_PARTICIPANT");
    }

    publishUserReport({
      context: "PRIVATE",
      roomId: params.roomId,
      reporterId: params.reporterId,
      targetUserId: params.targetUserId,
      reason: params.reason,
      description: params.description,
    });

    logger.info(
      `Private user report: room=${params.roomId} reporter=${params.reporterId} target=${params.targetUserId}`
    );
    return { ok: true };
  }

  async clearChat(roomId: string, userId: string): Promise<void> {
    const room = await this.privateRoomRepo.findByRoomId(roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");

    const isParticipant = room.participants?.includes(userId);
    if (!isParticipant) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");

    await this.privateRoomRepo.setClearFor(roomId, userId);

    this.redis
      .publish(
        `user:${userId}`,
        JSON.stringify({
          event: "conv:cleared",
          data: { roomId, clearedBy: userId, type: "PRIVATE" },
        })
      )
      .catch(() => {});

    // The row STAYS in the list (clear ≠ delete conversation) but now has no
    // visible message, so its effective lastActivity is empty and it must drop
    // to the bottom. `conv:cleared` alone left every other device — and any
    // client that only listens for list bumps — rendering the cleared chat at
    // the top with its old preview until a hard reload. Self-only: the peer's
    // view is untouched by a one-sided clear.
    publishConvUpdatedSafe({
      redis: this.redis,
      type: "PRIVATE",
      roomId,
      recipientIds: [userId],
      // Emptied row: no message, so no sender and no name.
      senderId: "",
      senderName: "",
      lastMessageId: "",
      lastMessageAt: 0,
      preview: { contentType: "", text: "", createdAt: 0 },
      // An emptied row is not a new message — must never raise an unread badge.
      countInUnread: false,
      // `setClearFor` above already zeroed this user's stored counter; state it
      // explicitly so the client SETs 0 instead of keeping a badge for messages
      // it can no longer show.
      resolveUnreadCounts: async () => ({ [userId]: 0 }),
      // 0 is BELOW whatever the client currently shows, so without this marker
      // the monotonic list guard drops the clear and the row stays at the top.
      deleteRecalc: true,
    });
  }

  /**
   * Fan the caller's own conversation-mute state to EVERY device they have
   * open — the chat counterpart of community's
   * `community:notification-setting-updated`. Emitted from the single
   * mute/unmute path (not from the bulk service) so one-off and bulk changes
   * are impossible to desync: whichever route wrote the state, every device
   * hears the same event.
   *
   * Self-only by design, and enforced a second time at the gateway: `user:<id>`
   * is also joined by presence WATCHERS, so this must be in chat.ns.ts's
   * `isSelfOnlyEvent` list or a peer would learn the caller muted them.
   *
   * Best-effort — a Redis hiccup must never fail the mute write itself.
   */
  private publishMuteChanged(
    roomId: string,
    userId: string,
    isMuted: boolean,
    muteUntil: Date | null
  ): void {
    this.redis
      .publish(
        `user:${userId}`,
        JSON.stringify({
          event: isMuted ? "conv:muted" : "conv:unmuted",
          data: {
            roomId,
            conversationId: roomId,
            type: "PRIVATE",
            isMuted,
            mutedUntil: muteUntil ? muteUntil.toISOString() : null,
            updatedAt: Date.now(),
          },
        })
      )
      .catch((err: unknown) => {
        logger.warn(
          `PrivateRoomService|conv:${isMuted ? "muted" : "unmuted"} publish failed room=${roomId} user=${userId}: ${String(err)}`
        );
      });
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
    this.publishMuteChanged(roomId, userId, true, muteUntil);
    return updated ?? room;
  }

  async unmuteRoom(roomId: string, userId: string): Promise<PrivateRoom> {
    const room = await this.privateRoomRepo.findByRoomId(roomId);
    if (!room || !room.participants?.includes(userId))
      throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    const updated = await this.privateRoomRepo.setUnmuted(roomId, userId);
    this.publishMuteChanged(roomId, userId, false, null);
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
