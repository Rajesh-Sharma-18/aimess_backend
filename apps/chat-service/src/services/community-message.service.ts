import { logger } from "@aimess/logger";
import {
  BadRequestError,
  ForbiddenError,
  GoneError,
  NotFoundError,
} from "@aimess/errors";
import { redis } from "../config/redis.js";

import {
  CHAT_EDIT_WINDOW_MS,
  CHAT_TEXT_MAX_CHARS,
  assertAttachmentsValid,
} from "../constants/media-limits.js";
import {
  buildCommunitySystemFallbackText,
  sanitizeCommunitySystemMetadata,
  type CommunitySystemMessageType,
} from "@aimess/constants";
import { env } from "../config/env.js";

import type { GeneralRoomMessageRepository } from "../repositories/general-room-message.repository.js";
import type { GeneralRoomRepository } from "../repositories/general-room.repository.js";
import type { RoomMemberRepository } from "../repositories/room-member.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import type {
  GeneralRoomMessage,
  RoomMember,
} from "../generated/prisma/index.js";
import {
  normalizeMessageType,
  toggleStoredReaction,
  toWireMessage,
} from "../lib/chat-message.serializer.js";
import { convertMessageToPreview } from "./message-preview.service.js";
import type { CommunitySystemMessageService } from "./community-system-message.service.js";
import {
  assertCommunityMember,
  assertCommunityReadAccess,
  assertCommunityRoomWritable,
} from "../lib/access-guard.js";
import { isDuplicateKeyError } from "../lib/db-errors.js";
import { markIdempotentReplay } from "../lib/idempotency.js";
import {
  resolveMediaUrlMap,
  urlFromMap,
  applyUrlMapToFiles,
  fileMediaKey,
  type MediaFileLike,
} from "../lib/media-resolve.js";

/**
 * Client-facing community message row: the raw Prisma entity with its
 * LOWER-CASE `messageType` dropped and replaced by an UPPER-CASE `contentType`
 * (§1 single client-facing casing). Used as the return element of every REST
 * read path so HTTP clients never see the internal `messageType` field.
 */
type MemberReadStatus = {
  userId: string;
  lastReadAt: Date | null;
  joinedAt: Date;
};

type CommunityMessageWire = Omit<
  GeneralRoomMessage,
  "messageType" | "visibleToUserId"
> & {
  contentType: string;
  /** Members whose read cursor is at or past this message's createdAt. */
  readBy: Array<{ userId: string; readAt: number }>;
  /** Members who were active in the room when this message was sent. */
  deliveredTo: Array<{ userId: string; deliveredAt: number }>;
  /** True for user-scoped SYSTEM messages (e.g. "You joined the community"). */
  isPersonal?: boolean;
};

/** Per-community chat summary for the GET /communities/mine enrichment. */
export interface CommunityChatSummary {
  communityId: string;
  unreadMessageCount: number;
  /** false => the caller should render lastMessageActivity as null. */
  hasLastMessage: boolean;
  lastMessage?: {
    username: string;
    message: string;
    /** epoch ms */
    dateTime: number;
  };
  /**
   * The viewer's latest PERSONAL system line (e.g. "You joined the community"),
   * visible only to this user. community-service overlays it onto the per-viewer
   * /communities/mine lastActivity when it is newer than the community-wide
   * activity, so the joiner sees their own join line while others do not. Absent
   * when the viewer has no personal line in that community.
   */
  personalLastMessage?: {
    message: string;
    /** epoch ms */
    dateTime: number;
  };
}

/** A viewer is an active member when their loaded RoomMember row is "active".
 *  Drives the membership-session read guard (`viewerIsActiveMember`) — a left /
 *  non-member (PUBLIC) reader must not see their own prior-session join line. */
function isActiveMember(
  member: { status?: string | null } | null | undefined
): boolean {
  return member?.status === "active";
}

/** Denormalized last-message JSON stored on a GeneralRoom. */
interface RoomLastMessageJson {
  content?: string;
  senderId?: string;
  senderName?: string;
  messageType?: string;
  createdAt?: string | Date;
}

export class CommunityMessageService {
  constructor(
    private readonly messageRepo: GeneralRoomMessageRepository,
    private readonly roomRepo: GeneralRoomRepository,
    private readonly memberRepo: RoomMemberRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService,
    /**
     * Optional — when provided, pin/unpin emit PINNED_MESSAGE / UNPINNED_MESSAGE
     * SYSTEM lines. Optional so the many 5-arg construction sites (tests,
     * app-factory) keep working untouched; production wires it in server.ts.
     */
    private readonly systemMessageService?: CommunitySystemMessageService
  ) {}

  /**
   * Idempotently provision (or re-activate) a community's chat room
   * (GeneralRoom, id === communityId). Invoked synchronously by community-service
   * at creation time via gRPC so a member's first send can't race ahead of the
   * async `community.created` event (which remains a backstop). Delegates to the
   * same repository upsert the event consumer and boot reconciler use, so all
   * three provisioning paths produce identical rows.
   */
  async provisionRoom(params: {
    communityId: string;
    name: string;
    owner?: string | null;
    logo?: string | null;
  }): Promise<void> {
    await this.roomRepo.provisionForCommunity(params.communityId, {
      name: params.name,
      owner: params.owner ?? null,
      logo: params.logo ?? null,
    });
  }

  async sendMessage(params: {
    roomId: string;
    sentBy: string;
    senderName: string;
    senderAvatar: string;
    message: string;
    messageType: string;
    parentMessageId?: string | null;
    clientMessageId?: string | null;
    attachments?: Array<Record<string, unknown>>;
  }): Promise<GeneralRoomMessage> {
    // Defensive caps (the gRPC/socket send path doesn't run the Zod validators).
    if ((params.message?.length ?? 0) > CHAT_TEXT_MAX_CHARS) {
      throw new BadRequestError("CHAT_TEXT_TOO_LONG");
    }
    assertAttachmentsValid(params.messageType, params.attachments);

    // Guard: block sends to suspended or deactivated rooms. "suspended" means
    // the community was closed (owner status=CLOSED or platform SUSPENDED);
    // "inactive" means it was deleted. This check runs before idempotency so a
    // closed-community retry never returns a previously-cached message as if the
    // send succeeded. Single source of truth for community write-ability.
    const room = await this.roomRepo.findRoomById(params.roomId);
    assertCommunityRoomWritable(room);

    // Sender must be an ACTIVE community member. A BANNED (or LEFT) member's
    // RoomMember row is mirrored as non-"active" by the community sync consumer,
    // so this rejects banned users with CHAT_NOT_A_MEMBER. Read/edit/delete/
    // react/pin paths already guard this way; send is the write chokepoint.
    await assertCommunityMember(this.memberRepo, params.roomId, params.sentBy);

    // Check idempotency
    if (params.clientMessageId) {
      const idemKey = `${params.roomId}:${params.sentBy}:${params.clientMessageId}`;
      const cachedId = await this.cacheRepo.getMessageIdempotency(idemKey);
      if (cachedId) {
        const cached = await this.messageRepo.findById(cachedId);
        if (cached) return markIdempotentReplay(cached);
      }
      const existing = await this.messageRepo.findOne({
        roomId: params.roomId,
        sentBy: params.sentBy,
        clientMessageId: params.clientMessageId,
      });
      if (existing) {
        this.cacheRepo
          .setMessageIdempotency(idemKey, existing.id)
          .catch(() => {});
        return markIdempotentReplay(existing);
      }
    }

    // Allocate a per-room monotonic sequence number (parity with private/group
    // rooms) so community sync/pagination can use gap-safe keyset cursors. Runs
    // after the idempotency pre-check so replays don't burn numbers; a rare
    // concurrent-race P2002 below may leave a one-number gap (acceptable).
    const sequenceNumber = await this.roomRepo.allocateSequence(params.roomId);

    const entity: Record<string, unknown> = {
      roomId: params.roomId,
      sentBy: params.sentBy,
      senderName: params.senderName,
      senderAvatar: params.senderAvatar,
      message: params.message || "",
      // §1 single casing: store the canonical UPPER-CASE type (matches the
      // private/group services, which both persist via normalizeMessageType).
      // The gRPC send handler already upper-cases contentType, so this is a
      // no-op for live sends but guarantees UPPER for any other caller.
      messageType: normalizeMessageType(params.messageType),
      parentMessageId: params.parentMessageId || null,
      clientMessageId: params.clientMessageId || null,
      sequenceNumber,
    };

    if (params.attachments?.length) {
      entity.attachments = params.attachments;
    }

    // If reply, attach quote data
    if (params.parentMessageId) {
      const originalMsg = await this.messageRepo.findById(
        params.parentMessageId
      );
      if (originalMsg) {
        entity.quoteData = {
          message: originalMsg.message,
          senderName: originalMsg.senderName,
        };
      }
    }

    let message: GeneralRoomMessage;
    try {
      message = await this.messageRepo.save(
        entity as Parameters<typeof this.messageRepo.save>[0]
      );
    } catch (err) {
      // Concurrent send with the same clientMessageId lost the unique-index
      // insert (E11000/P2002 from the sparse idempotency index) — re-read and
      // return the winner so both collapse to one message.
      if (isDuplicateKeyError(err) && params.clientMessageId) {
        const dup = await this.messageRepo.findOne({
          roomId: params.roomId,
          sentBy: params.sentBy,
          clientMessageId: params.clientMessageId,
        });
        if (dup) return markIdempotentReplay(dup);
      }
      throw err;
    }

    if (params.clientMessageId) {
      const idemKey = `${params.roomId}:${params.sentBy}:${params.clientMessageId}`;
      this.cacheRepo.setMessageIdempotency(idemKey, message.id).catch(() => {});
    }

    // Update room last message
    this.roomRepo
      .addLastestMessageToRoom(params.roomId, {
        _id: message.id,
        sentBy: message.sentBy,
        senderName: message.senderName || "",
        message: message.message || "",
        messageType: message.messageType,
        createdAt: message.createdAt,
      })
      .catch((err: unknown) => {
        logger.warn(
          `CommunityMessageService|addLastestMessageToRoom failed: ${String(err)}`
        );
      });
    return message;
  }

  /**
   * Offline catch-up: returns missed messages for a community room.
   *
   * Two modes (mutually exclusive — sinceTs takes precedence when both supplied):
   *
   *   sinceTs > 0  — updatedAt-based sweep. Queries via `findUpdatedAtSince`,
   *                  which includes tombstones, edits, and reaction changes.
   *                  Returns `nextTs` (epoch-ms of last event's updatedAt) for
   *                  continued paging.
   *
   *   sinceId      — ObjectId insertion-order query via `findSinceId`.  Includes
   *                  tombstones (deletedForAll=true) so clients can reconcile
   *                  offline deletes.  nextTs is 0 in this mode.
   *
   * Authorizes that the requesting user is an active member before querying.
   */
  async catchup(params: {
    roomId: string;
    userId: string;
    sinceId: string;
    sinceTs?: Date;
    limit: number;
  }): Promise<{
    events: GeneralRoomMessage[];
    hasMore: boolean;
    lastId: string;
    nextTs: number;
    authorized: boolean;
  }> {
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member || member.status !== "active") {
      return {
        events: [],
        hasMore: false,
        lastId: params.sinceId,
        nextTs: 0,
        authorized: false,
      };
    }

    // P2 §13: max 100 events per room per catchup to prevent oversized payloads.
    const limit = Math.min(Math.max(params.limit || 100, 1), 100);

    // since_ts mode: updatedAt-based query that catches all mutation types.
    if (params.sinceTs && !Number.isNaN(params.sinceTs.getTime())) {
      const { messages: tsMessages, hasMore } =
        await this.messageRepo.findUpdatedAtSince({
          roomId: params.roomId,
          userId: params.userId,
          fromTs: params.sinceTs,
          limit,
        });
      const lastMsg =
        tsMessages.length > 0 ? tsMessages[tsMessages.length - 1]! : null;
      const lastId = lastMsg?.id ?? params.sinceId;
      const nextTs =
        lastMsg?.updatedAt instanceof Date ? lastMsg.updatedAt.getTime() : 0;
      return {
        events: tsMessages,
        hasMore,
        lastId,
        nextTs,
        authorized: true,
      };
    }

    // since_id mode: ObjectId ordering (insertion-order). Tombstones included.
    const { messages, hasMore } = await this.messageRepo.findSinceId({
      roomId: params.roomId,
      userId: params.userId,
      sinceId: params.sinceId,
      limit,
    });
    const lastId =
      messages.length > 0 ? messages[messages.length - 1]!.id : params.sinceId;
    return { events: messages, hasMore, lastId, nextTs: 0, authorized: true };
  }

  /**
   * Active member userIds for a community room — the recipient list for the
   * community list "bump-to-top" (`community:updated`) fan-out.
   */
  async getActiveMemberIds(roomId: string): Promise<string[]> {
    const members = await this.memberRepo.findActiveByRoom(roomId);
    return members.map((m) => m.userId);
  }

  /**
   * Bulk community-chat summaries for GET /communities/mine. For each requested
   * communityId (roomId === communityId): unread count + last-message preview,
   * but ONLY for communities the user is an ACTIVE member of (member-only
   * previews). Non-member communities get `unreadMessageCount: 0` +
   * `hasLastMessage: false`. Single bulk query per concern — no N+1.
   */
  async getChatSummaries(params: {
    userId: string;
    communityIds: string[];
  }): Promise<CommunityChatSummary[]> {
    const ids = [...new Set(params.communityIds.filter(Boolean))];
    if (!ids.length) return [];

    // 1. Active membership rows → member roomIds + per-room read threshold.
    const members = await this.memberRepo.findActiveByUserAndRooms(
      params.userId,
      ids
    );
    const readMap = new Map<string, Date | null>(
      members.map((m) => [m.roomId, m.lastReadAt])
    );
    const memberRoomIds = members.map((m) => m.roomId);

    // 2/3/4. In parallel: member rooms (lastMessage JSON) + bulk unread counts +
    // the viewer's latest PERSONAL line per room (e.g. "You joined the community").
    const [rooms, unreadMap, personalMap] = await Promise.all([
      this.roomRepo.findManyByIds(memberRoomIds),
      memberRoomIds.length
        ? this.messageRepo.countUnreadBulk({
            userId: params.userId,
            thresholds: memberRoomIds.map((roomId) => ({
              roomId,
              afterDate: readMap.get(roomId) ?? new Date(0),
            })),
          })
        : Promise.resolve<Record<string, number>>({}),
      memberRoomIds.length
        ? this.messageRepo.findLatestPersonalByRooms({
            userId: params.userId,
            roomIds: memberRoomIds,
          })
        : Promise.resolve(
            new Map<string, { message: string; createdAt: Date }>()
          ),
    ]);
    const roomById = new Map(rooms.map((r) => [r.id, r]));

    // 4. Build a summary for EVERY requested community.
    return ids.map((communityId) => {
      if (!readMap.has(communityId)) {
        // Not an active member → no preview, zero unread (member-only previews).
        return {
          communityId,
          unreadMessageCount: 0,
          hasLastMessage: false,
        };
      }

      const room = roomById.get(communityId);
      const last = (room?.lastMessage ?? null) as RoomLastMessageJson | null;
      const unreadMessageCount = unreadMap[communityId] ?? 0;

      // The viewer's own personal line (e.g. "You joined the community"). Carried
      // separately so community-service can overlay it per-viewer without
      // disturbing the community-wide preview/ordering for anyone else.
      const personal = personalMap.get(communityId);
      const personalLastMessage =
        personal && personal.message
          ? {
              message: personal.message,
              dateTime: personal.createdAt.getTime(),
            }
          : undefined;

      if (!last || !last.createdAt) {
        return {
          communityId,
          unreadMessageCount,
          hasLastMessage: false,
          ...(personalLastMessage ? { personalLastMessage } : {}),
        };
      }

      const createdAt =
        last.createdAt instanceof Date
          ? last.createdAt
          : new Date(last.createdAt);

      // SYSTEM messages are sender-less: the preview is a complete sentence
      // (e.g. "John joined the community"), so the community list must NEVER
      // prefix it with a sender name. Force username empty for SYSTEM, mirroring
      // the REST `lastActivity` rule in community-service's buildLastActivity.
      const messageType = last.messageType ?? "";
      const isSystem = messageType.toUpperCase() === "SYSTEM";

      return {
        communityId,
        unreadMessageCount,
        hasLastMessage: true,
        lastMessage: {
          username: isSystem ? "" : (last.senderName ?? ""),
          message: convertMessageToPreview(messageType, last.content),
          dateTime: Number.isNaN(createdAt.getTime()) ? 0 : createdAt.getTime(),
        },
        ...(personalLastMessage ? { personalLastMessage } : {}),
      };
    });
  }

  async bulkMarkRead(userId: string, communityIds: string[]): Promise<number> {
    const ids = [...new Set(communityIds.filter(Boolean))];
    if (!ids.length) return 0;
    return this.memberRepo.bulkAdvanceReadToNow(userId, ids);
  }

  /**
   * Map a raw Prisma message to the client wire shape: drop the LOWER-CASE
   * `messageType` and add an UPPER-CASE `contentType` (§1). Every other field
   * (id, roomId, sentBy, senderName, senderAvatar, message, attachments,
   * reactions, deletedForAll, editedAt, createdAt, updatedAt, parentMessageId,
   * …) is preserved unchanged. Applied at the RETURN site of REST read paths
   * only — internal logic continues to read the raw rows.
   */
  /**
   * Collect every stored media key on a page of community rows (sender avatars +
   * attachment object keys) and resolve them ONCE to full download URLs. Pass
   * the returned map to {@link toWire} so each row serializes synchronously and
   * the FE never receives a raw object key.
   */
  private resolveRowsMedia(
    rows: GeneralRoomMessage[]
  ): Promise<Map<string, string>> {
    const keys: string[] = [];
    for (const m of rows) {
      if (m.senderAvatar) keys.push(m.senderAvatar);
      const attachments = m.attachments;
      if (Array.isArray(attachments)) {
        for (const attachment of attachments) {
          const key = fileMediaKey(attachment as MediaFileLike);
          if (key) keys.push(key);
        }
      }
    }
    return resolveMediaUrlMap(keys);
  }

  /** Extract every unique reactor userId from a batch of message rows. */
  private collectReactionUserIds(rows: GeneralRoomMessage[]): string[] {
    const ids = new Set<string>();
    for (const row of rows) {
      const reactions = row.reactions as Record<string, unknown> | null;
      if (!reactions || typeof reactions !== "object") continue;
      for (const list of Object.values(reactions)) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
          const uid =
            typeof entry === "string"
              ? entry
              : (entry as Record<string, unknown>)?.userId;
          if (typeof uid === "string" && uid) ids.add(uid);
        }
      }
    }
    return [...ids];
  }

  /**
   * Personalize a SYSTEM line's third-person text for one viewer ("You joined
   * the community", "You are now a moderator"), or return it unchanged. Single
   * source of truth shared by the history wire (`toWire`) and the sync mapper
   * (`getMessagesSince`) so the metadata extraction isn't duplicated. Returns the
   * input text untouched when there is no viewer or no system subtype.
   */
  private personalizeSystemText(
    systemMessageType: string | null | undefined,
    systemMetadata: unknown,
    storedText: string,
    viewerUserId: string | undefined
  ): string {
    if (!systemMessageType) return storedText;
    const metadata = (systemMetadata ?? {}) as Record<string, unknown>;

    // Always rebuild from the canonical builder. This achieves three things:
    //
    //  1. CANONICAL UPGRADE — stale stored rows written by old code (e.g.
    //     "Jim Methews created the community") are transparently upgraded to the
    //     current text ("Community created") with no DB migration required.
    //
    //  2. PERSONALIZATION — when the viewer is the actor or target of the
    //     event, the builder switches to the "You …" first-person form
    //     ("You are now a moderator" vs "John Doe is now a moderator").
    //
    //  3. SSoT — Chat Room / Sync / Socket read paths all produce the same
    //     text because they all run through this single rebuild gate.
    //
    // storedText is only used as a final fallback in the impossible case that
    // the builder returns empty (the default case in the switch never fires,
    // so this guard is purely defensive).
    const rebuilt = buildCommunitySystemFallbackText(
      systemMessageType as CommunitySystemMessageType,
      metadata,
      String(metadata.actorName ?? ""),
      String(metadata.targetName ?? ""),
      viewerUserId ?? ""
    );
    return rebuilt || storedText;
  }

  private toWire(
    m: GeneralRoomMessage,
    members?: MemberReadStatus[],
    urlMap?: Map<string, string>,
    resolveReactionUser?: (
      userId: string
    ) => { displayName: string; avatarUrl: string } | undefined,
    viewerUserId?: string
  ): CommunityMessageWire {
    const wire = toWireMessage(m) as Record<string, unknown>;

    // Resolve raw object keys → full download URLs on read (never persisted, so
    // CDN/presign rotation keeps working). Internal logic still reads raw rows.
    if (urlMap) {
      if (typeof wire.senderAvatar === "string") {
        wire.senderAvatar = urlFromMap(urlMap, wire.senderAvatar);
      }
      if (Array.isArray(wire.attachments)) {
        wire.attachments = applyUrlMapToFiles(
          wire.attachments as MediaFileLike[],
          urlMap
        );
      }
    }

    // Rename avatar → avatarUrl and resolve S3 object-keys to full presigned
    // download URLs inside the stored reactions map. No new field is added.
    if (wire.reactions && typeof wire.reactions === "object") {
      const raw = wire.reactions as Record<string, unknown>;
      const out: Record<string, unknown[]> = {};
      for (const [emoji, list] of Object.entries(raw)) {
        if (!Array.isArray(list)) continue;
        out[emoji] = list.map((r) => {
          const reactor = (r ?? {}) as Record<string, unknown>;
          const { avatar, ...rest } = reactor;
          const snap = resolveReactionUser?.(reactor.userId as string);
          return {
            ...rest,
            avatarUrl:
              snap?.avatarUrl ||
              (urlMap ? urlFromMap(urlMap, (avatar as string) || "") : "") ||
              "",
          };
        });
      }
      wire.reactions = out;
    }

    // Normalize editedAt → epoch ms and derive isEdited so all list/timeline
    // surfaces are consistent with the edit socket event and sync API.
    const editedMs =
      m.editedAt instanceof Date ? m.editedAt.getTime() : (m.editedAt ?? null);
    wire.isEdited = editedMs !== null && editedMs > 0;
    wire.editedAt = editedMs;

    const msgTs = m.createdAt;

    const readBy = members
      ? members
          .filter((mem) => mem.lastReadAt !== null && mem.lastReadAt >= msgTs)
          .map((mem) => ({
            userId: mem.userId,
            readAt: mem.lastReadAt!.getTime(),
          }))
      : [];

    const deliveredTo = members
      ? members
          .filter((mem) => mem.joinedAt <= msgTs)
          .map((mem) => ({
            userId: mem.userId,
            deliveredAt: msgTs.getTime(),
          }))
      : [];

    // Surface a clean `isPersonal` flag for the client (e.g. "You joined this
    // community") and DROP the raw `visibleToUserId` targeting column from the
    // wire — it is an internal access-control field, not a client contract.
    const isPersonal = Boolean(
      (wire as Record<string, unknown>).visibleToUserId
    );
    delete (wire as Record<string, unknown>).visibleToUserId;
    wire.isPersonal = isPersonal;

    // SYSTEM messages are SENDER-LESS (Telegram-style): never expose
    // senderId/senderName/senderAvatar — the actor lives in systemMetadata only.
    // Also blank the internal idempotency token we stash in `clientMessageId`
    // (the system-event dedup key); it is not part of the client contract.
    if (String(wire.contentType).toUpperCase() === "SYSTEM") {
      wire.senderId = "";
      wire.sentBy = "";
      wire.senderName = "";
      wire.senderAvatar = "";
      wire.clientMessageId = "";

      const thirdPersonText = String(wire.message ?? "");
      const personalized = this.personalizeSystemText(
        m.systemMessageType,
        m.systemMetadata,
        thirdPersonText,
        viewerUserId
      );
      if (personalized !== thirdPersonText) {
        wire.message = personalized;
        const content = wire.content as Record<string, unknown> | null;
        if (content && typeof content === "object") {
          wire.content = { ...content, text: personalized };
        }
      }

      // ACTOR-LESS lifecycle lines must not leak actor identity to the client
      // (which localizes from systemMetadata). Strip actor/target keys so a
      // legacy row that stored creatorName/actorName can never render
      // "{name} created the community". No-op for actor-bearing types.
      wire.systemMetadata = sanitizeCommunitySystemMetadata(
        m.systemMessageType,
        wire.systemMetadata as Record<string, unknown> | null | undefined
      );
    }

    return { ...wire, readBy, deliveredTo } as CommunityMessageWire;
  }

  async getMessages(params: {
    roomId: string;
    userId: string;
    cursor?: string | null;
    limit: number;
  }): Promise<CommunityMessageWire[]> {
    // For community messages, allow reads if:
    // 1. User is an active member, OR
    // 2. The community is PUBLIC (non-members can read history)
    const { member } = await assertCommunityReadAccess(
      this.roomRepo,
      this.memberRepo,
      params.roomId,
      params.userId
    );
    const viewerIsActiveMember = isActiveMember(member);
    const beforeTimestamp = params.cursor || new Date().toISOString();
    const [rows, members] = await Promise.all([
      this.messageRepo.findByRoomIdWithTime(
        params.roomId,
        beforeTimestamp,
        "older",
        params.limit,
        params.userId,
        viewerIsActiveMember
      ),
      this.memberRepo.findReadStatusByRoom(params.roomId),
    ]);
    const urlMap = await this.resolveRowsMedia(rows);
    return rows.map((m) =>
      this.toWire(m, members, urlMap, undefined, params.userId)
    );
  }

  /**
   * Timestamp-keyset page (before_ts / after_ts). Over-fetches one extra row so
   * `hasMore` is exact; `nextCursor` is the boundary createdAt as epoch-ms.
   */
  async getMessagesTimeline(params: {
    roomId: string;
    userId: string;
    direction: "before" | "after";
    ts: Date;
    limit: number;
  }): Promise<{
    items: CommunityMessageWire[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    // For community messages, allow reads if:
    // 1. User is an active member, OR
    // 2. The community is PUBLIC (non-members can read history)
    const { member } = await assertCommunityReadAccess(
      this.roomRepo,
      this.memberRepo,
      params.roomId,
      params.userId
    );
    const [rows, members] = await Promise.all([
      this.messageRepo.findByRoomIdTimeline({
        roomId: params.roomId,
        userId: params.userId,
        direction: params.direction,
        ts: params.ts,
        limit: params.limit,
        viewerIsActiveMember: isActiveMember(member),
      }),
      this.memberRepo.findReadStatusByRoom(params.roomId),
    ]);

    const hasMore = rows.length > params.limit;
    const pageRows = rows.slice(0, params.limit);

    // For "before" direction the DB fetches newest-first so LIMIT correctly
    // selects the closest-to-cursor window. The boundary for the next page is
    // the oldest item in that window (pageRows tail). Reverse before returning
    // so every response surface is oldest→newest (ascending chronological order).
    const boundary = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && boundary ? String(boundary.createdAt.getTime()) : null;

    const orderedItems =
      params.direction === "before" ? [...pageRows].reverse() : pageRows;

    // Fetch reactor snapshots first so we can collect their avatar object-keys
    // and resolve them to full presigned download URLs in the same batch as the
    // rest of the message media.
    const snapsMap = await this.userSnapshotService.getUserSnapshotsMap(
      this.collectReactionUserIds(orderedItems),
      this.cacheRepo
    );
    const snapAvatarKeys = [...snapsMap.values()]
      .map((s) => (s.avatar as string) || "")
      .filter(Boolean);

    const [msgUrlMap, snapAvatarUrlMap] = await Promise.all([
      this.resolveRowsMedia(orderedItems),
      resolveMediaUrlMap(snapAvatarKeys),
    ]);
    // Merge so toWire can resolve any avatar object-key (snap or legacy stored)
    // with a single urlMap lookup, with no separate map needed in the caller.
    const urlMap = new Map([...msgUrlMap, ...snapAvatarUrlMap]);

    const resolveReactionUser = (userId: string) => {
      const snap = snapsMap.get(userId);
      return snap
        ? {
            displayName: (snap.displayName as string) || "",
            avatarUrl:
              urlFromMap(snapAvatarUrlMap, (snap.avatar as string) || "") || "",
          }
        : undefined;
    };

    return {
      items: orderedItems.map((m) =>
        this.toWire(m, members, urlMap, resolveReactionUser, params.userId)
      ),
      hasMore,
      nextCursor,
    };
  }

  /**
   * Incremental sync (`after_ts` mode) — returns every message (new, edited,
   * reacted, deleted tombstone) whose `updatedAt >= fromTs`. Designed for
   * offline-first mobile clients catching up after a background period.
   *
   * Key differences from `getMessagesTimeline` (`before_ts` / scroll mode):
   * - Queries by `updatedAt` so edits, reaction changes, and deletes are
   *   included alongside new messages.
   * - Tombstones (`deletedForAll=true`) ARE returned — client reconciles.
   * - Each item carries grouped reactions ready for direct rendering.
   * - `nextCursor` is the epoch-ms `updatedAt` of the last item; the client
   *   stores it and sends it back as the next `after_ts`.
   */
  async getMessagesSince(params: {
    roomId: string;
    userId: string;
    fromTs: Date;
    limit: number;
  }): Promise<{
    items: Array<{
      id: string;
      roomId: string;
      sentBy: string;
      senderName: string | null;
      senderAvatar: string | null;
      message: string | null;
      contentType: string;
      attachments: unknown;
      reactions: Array<{
        emoji: string;
        count: number;
        users: Array<{
          userId: string;
          displayName: string;
          avatarUrl: string;
        }>;
      }>;
      deletedForAll: boolean;
      isEdited: boolean;
      editedAt: number | null;
      createdAt: number;
      updatedAt: number;
      syncEventType: "new" | "edited" | "deleted" | "reacted";
    }>;
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    // For community messages, allow reads if:
    // 1. User is an active member, OR
    // 2. The community is PUBLIC (non-members can read history)
    // Note: sync path is typically members-only (offline-first mobile), but we enforce
    // the same rules for consistency.
    const { member } = await assertCommunityReadAccess(
      this.roomRepo,
      this.memberRepo,
      params.roomId,
      params.userId
    );

    if (Number.isNaN(params.fromTs.getTime())) {
      throw new BadRequestError("CHAT_INVALID_SINCE_TS");
    }
    const { messages, hasMore } = await this.messageRepo.findUpdatedAtSince({
      roomId: params.roomId,
      userId: params.userId,
      fromTs: params.fromTs,
      limit: params.limit,
      viewerIsActiveMember: member?.status === "active",
    });

    const last = messages[messages.length - 1];
    const nextCursor =
      hasMore && last ? String(last.updatedAt.getTime()) : null;

    // Resolve sender avatars, attachment keys, and reaction-user avatars on read
    // so the incremental-sync payload never carries a raw object key.
    const mediaKeys: string[] = [];
    for (const msg of messages) {
      if (msg.senderAvatar) mediaKeys.push(msg.senderAvatar);
      if (Array.isArray(msg.attachments)) {
        for (const attachment of msg.attachments) {
          const key = fileMediaKey(attachment as MediaFileLike);
          if (key) mediaKeys.push(key);
        }
      }
    }
    const syncSnapsMap = await this.userSnapshotService.getUserSnapshotsMap(
      this.collectReactionUserIds(messages),
      this.cacheRepo
    );
    const syncSnapAvatarKeys = [...syncSnapsMap.values()]
      .map((s) => (s.avatar as string) || "")
      .filter(Boolean);

    const [urlMap, syncAvatarUrlMap] = await Promise.all([
      resolveMediaUrlMap(mediaKeys),
      resolveMediaUrlMap(syncSnapAvatarKeys),
    ]);

    const items = messages.map((msg) => {
      const createdMs = msg.createdAt.getTime();
      const updatedMs = msg.updatedAt.getTime();
      const editedMs =
        msg.editedAt instanceof Date ? msg.editedAt.getTime() : null;

      // Derive what kind of mutation this update represents.
      let syncEventType: "new" | "edited" | "deleted" | "reacted";
      if (msg.deletedForAll) {
        syncEventType = "deleted";
      } else if (editedMs !== null) {
        syncEventType = "edited";
      } else if (updatedMs - createdMs > 2000) {
        // updatedAt is more than 2 s after createdAt — something mutated it
        // after creation (most likely a reaction, since edits set editedAt).
        syncEventType = "reacted";
      } else {
        syncEventType = "new";
      }

      // Transform stored reactions: rename avatar → avatarUrl, resolve S3 keys.
      const rawReactions = msg.reactions as Record<string, unknown> | null;
      const transformedReactions: Record<string, unknown[]> = {};
      if (rawReactions && typeof rawReactions === "object") {
        for (const [emoji, list] of Object.entries(rawReactions)) {
          if (!Array.isArray(list)) continue;
          transformedReactions[emoji] = list.map((r) => {
            const reactor = (r ?? {}) as Record<string, unknown>;
            const { avatar, ...rest } = reactor;
            const snap = syncSnapsMap.get(reactor.userId as string);
            return {
              ...rest,
              avatarUrl: snap
                ? urlFromMap(syncAvatarUrlMap, (snap.avatar as string) || "") ||
                  ""
                : urlFromMap(urlMap, (avatar as string) || "") || "",
            };
          });
        }
      }

      let messageText = msg.message ?? null;
      const contentType = normalizeMessageType(msg.messageType);
      if (contentType === "SYSTEM") {
        messageText = this.personalizeSystemText(
          msg.systemMessageType,
          msg.systemMetadata,
          messageText ?? "",
          params.userId
        );
      }

      return {
        id: msg.id,
        roomId: msg.roomId,
        sentBy: contentType === "SYSTEM" ? "" : msg.sentBy,
        senderName: contentType === "SYSTEM" ? null : (msg.senderName ?? null),
        senderAvatar:
          contentType === "SYSTEM"
            ? null
            : urlFromMap(urlMap, msg.senderAvatar) || null,
        message: messageText,
        contentType,
        attachments: Array.isArray(msg.attachments)
          ? applyUrlMapToFiles(msg.attachments as MediaFileLike[], urlMap)
          : msg.attachments,
        reactions: Object.entries(transformedReactions).map(
          ([emoji, users]) => ({
            emoji,
            count: users.length,
            users: users as Array<{
              userId: string;
              displayName: string;
              avatarUrl: string;
            }>,
          })
        ),
        deletedForAll: msg.deletedForAll,
        isEdited: editedMs !== null,
        editedAt: editedMs,
        createdAt: createdMs,
        updatedAt: updatedMs,
        syncEventType,
        systemMessageType:
          (msg as Record<string, unknown>).systemMessageType ?? null,
        systemMetadata:
          sanitizeCommunitySystemMetadata(
            msg.systemMessageType,
            (msg as Record<string, unknown>).systemMetadata as
              | Record<string, unknown>
              | null
              | undefined
          ) ?? null,
      };
    });

    return { items, hasMore, nextCursor };
  }

  /**
   * Jump-to-message window: resolves the anchor's createdAt, then fetches a
   * window of `limit` messages centered around it.
   */
  async getMessagesAround(params: {
    roomId: string;
    userId: string;
    messageId: string;
    limit: number;
  }): Promise<{ items: CommunityMessageWire[] }> {
    const { member } = await assertCommunityReadAccess(
      this.roomRepo,
      this.memberRepo,
      params.roomId,
      params.userId
    );
    const anchor = await this.messageRepo.findById(params.messageId);
    if (!anchor) {
      return { items: [] };
    }
    const [rows, members] = await Promise.all([
      this.messageRepo.findAroundDate({
        roomId: params.roomId,
        userId: params.userId,
        anchorDate: anchor.createdAt,
        limit: params.limit,
        viewerIsActiveMember: isActiveMember(member),
      }),
      this.memberRepo.findReadStatusByRoom(params.roomId),
    ]);
    const urlMap = await this.resolveRowsMedia(rows);
    return {
      items: rows.map((m) =>
        this.toWire(m, members, urlMap, undefined, params.userId)
      ),
    };
  }

  /**
   * Paginated conversation page for a community room + mark-as-read side effect.
   * Enforces active membership first (same check as listMedia), fetches the
   * offset page (createdAt < timestamp, newest first), then advances the
   * caller's read pointer to the newest returned message (forward-only).
   */
  async getConversation(params: {
    roomId: string;
    userId: string;
    pageNumber: number;
    limit: number;
    timestamp?: number;
  }): Promise<{ messages: CommunityMessageWire[]; total: number }> {
    // Enforce active membership first (banned/left members can't read).
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member || member.status !== "active")
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");

    const beforeMs = params.timestamp ?? Date.now();
    const skip = (params.pageNumber - 1) * params.limit;

    const [messages, total] = await Promise.all([
      this.messageRepo.listConversationMessages({
        roomId: params.roomId,
        userId: params.userId,
        beforeMs,
        skip,
        take: params.limit,
      }),
      // Count must match the page's filter (createdAt < beforeMs + per-user
      // deletion exclusion), not the boundary-less countByRoom.
      this.messageRepo.countConversation({
        roomId: params.roomId,
        userId: params.userId,
        beforeMs,
      }),
    ]);

    // Mark-as-read: advance to the newest message in the page (index 0, since
    // the page is createdAt DESC). Forward-only; skip when the page is empty.
    // Runs on the RAW rows (needs id/createdAt) before we map to the wire shape.
    const newest = messages[0];
    if (newest) {
      await this.memberRepo
        .advanceReadPointer(
          params.roomId,
          params.userId,
          newest.id,
          newest.createdAt
        )
        .catch((err: unknown) => {
          logger.warn(
            `CommunityMessageService|getConversation|advanceReadPointer failed: ${String(err)}`
          );
        });
    }

    const urlMap = await this.resolveRowsMedia(messages);
    return {
      messages: messages.map((m) =>
        this.toWire(m, undefined, urlMap, undefined, params.userId)
      ),
      total,
    };
  }

  async searchMessages(params: {
    roomId: string;
    userId: string;
    query: string;
    limit: number;
  }): Promise<CommunityMessageWire[]> {
    const { member } = await assertCommunityReadAccess(
      this.roomRepo,
      this.memberRepo,
      params.roomId,
      params.userId
    );
    const rows = await this.messageRepo.searchByText(
      params.roomId,
      params.query,
      params.limit,
      params.userId,
      isActiveMember(member)
    );
    const urlMap = await this.resolveRowsMedia(rows);
    return rows.map((m) =>
      this.toWire(m, undefined, urlMap, undefined, params.userId)
    );
  }

  async countMessages(roomId: string): Promise<number> {
    return this.messageRepo.countByRoom(roomId);
  }

  async countSearchResults(roomId: string, query: string): Promise<number> {
    return this.messageRepo.countSearchResults(roomId, query);
  }

  async listMedia(params: {
    roomId: string;
    userId: string;
    type?: string;
    cursor?: string | null;
    limit: number;
  }): Promise<CommunityMessageWire[]> {
    // Enforce active membership first (banned/left members can't list media).
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member || member.status !== "active")
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");

    const rows = await this.messageRepo.listMedia({
      roomId: params.roomId,
      userId: params.userId,
      type: params.type,
      cursor: params.cursor,
      limit: params.limit,
    });
    const urlMap = await this.resolveRowsMedia(rows);
    return rows.map((m) =>
      this.toWire(m, undefined, urlMap, undefined, params.userId)
    );
  }

  /** Bind a loaded message to its OWN room (never a body-supplied communityId)
   * and require the caller to be an ACTIVE member of that room. Returns the
   * member so callers needing the role (deleteForAll) avoid a second query.
   * NotFound — never Forbidden — so a foreign message's existence isn't leaked.
   * (cross-room IDOR guard for routes that carry no roomId.) */
  private async assertActiveMemberOfMessageRoom(
    message: GeneralRoomMessage,
    userId: string
  ): Promise<RoomMember> {
    const member = await this.memberRepo.findByRoomAndUser(
      message.roomId,
      userId
    );
    // Membership check FIRST so non-members get NotFound (no foreign-message
    // existence leak), THEN the write-ability gate so only real members learn a
    // room is closed/suspended.
    if (!member || member.status !== "active")
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    assertCommunityRoomWritable(
      await this.roomRepo.findRoomById(message.roomId)
    );
    return member;
  }

  async editMessage(params: {
    messageId: string;
    userId: string;
    content: { text: string };
  }): Promise<GeneralRoomMessage> {
    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    // Authorize against the message's OWN room (never a body-supplied communityId):
    // the caller must be an ACTIVE member of the room the message lives in BEFORE
    // any sender/type/window check. Mirrors reactToMessage/listMedia; NotFound so
    // foreign-message existence isn't leaked. (cross-room IDOR)
    await this.assertActiveMemberOfMessageRoom(message, params.userId);
    if (message.deletedForAll)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    if (message.sentBy !== params.userId)
      throw new BadRequestError("CHAT_EDIT_OWN_MESSAGES_ONLY");
    // Community messages are persisted with the canonical UPPER-CASE type
    // ("TEXT"), so the guard must compare against UPPER — comparing to the old
    // lower-case "text" rejected every edit (→ SERVICE_ERROR). normalizeMessageType
    // also tolerates any legacy lower-case rows. Mirrors private/group (!== "TEXT").
    if (normalizeMessageType(message.messageType) !== "TEXT")
      throw new BadRequestError("CHAT_EDIT_TEXT_ONLY");
    if ((params.content?.text?.length ?? 0) > CHAT_TEXT_MAX_CHARS)
      throw new BadRequestError("CHAT_TEXT_TOO_LONG");
    if (Date.now() - message.createdAt.getTime() > CHAT_EDIT_WINDOW_MS)
      throw new GoneError("CHAT_EDIT_WINDOW_EXPIRED");
    return this.messageRepo.editMessage(params.messageId, params.content.text);
  }

  async reactToMessage(params: {
    messageId: string;
    userId: string;
    emoji: string;
  }): Promise<{
    messageId: string;
    roomId: string;
    reactions: Array<{
      emoji: string;
      count: number;
      users: Array<{ userId: string; displayName: string; avatarUrl: string }>;
    }>;
  }> {
    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (message.deletedForAll)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    if (normalizeMessageType(message.messageType) === "SYSTEM")
      throw new BadRequestError("CHAT_SYSTEM_MESSAGE_IMMUTABLE");

    // Guard: only active members may react.
    const member = await this.memberRepo.findByRoomAndUser(
      message.roomId,
      params.userId
    );
    if (!member || member.status !== "active") {
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");
    }
    // ...and only when the community room is open (closed/suspended → read-only).
    assertCommunityRoomWritable(
      await this.roomRepo.findRoomById(message.roomId)
    );

    // Toggle the reactor in/out of the emoji bucket (shared with private/group);
    // non-atomic read-modify-write, acceptable at current scale.
    const updatedReactions = toggleStoredReaction(
      message.reactions,
      params.userId,
      params.emoji
    );

    // Fetch snapshots BEFORE persisting so the stored document carries real
    // userName / avatar / memberId (fixes the raw `reactions` field on read).
    const allUserIds = [
      ...new Set(
        Object.values(updatedReactions)
          .flat()
          .map((e) => e.userId)
          .filter(Boolean)
      ),
    ];

    const snaps =
      allUserIds.length > 0
        ? await this.userSnapshotService.getUserSnapshotsMap(
            allUserIds,
            this.cacheRepo
          )
        : new Map<string, Record<string, unknown>>();

    // Enrich stored reactor objects with live profile data.
    const enrichedReactions: Record<string, (typeof updatedReactions)[string]> =
      {};
    for (const [emoji, reactors] of Object.entries(updatedReactions)) {
      enrichedReactions[emoji] = reactors.map((r) => {
        const snap = snaps.get(r.userId);
        return {
          userId: r.userId,
          userName: (snap?.displayName as string) || r.userName || "",
          avatar: (snap?.avatar as string) || r.avatar || "",
          memberId: (snap?.memberId as string) || r.memberId || "",
        };
      });
    }

    await this.messageRepo.updateById(
      message.roomId,
      params.messageId,
      enrichedReactions
    );

    // Resolve the stored avatar object-keys to full presigned download URLs so
    // both the REST response and the socket broadcast carry real URLs.
    const allAvatarKeys = Object.values(enrichedReactions)
      .flat()
      .map((r) => r.avatar)
      .filter(Boolean);
    const avatarUrlMap = await resolveMediaUrlMap(allAvatarKeys);

    const reactionGroups = Object.entries(enrichedReactions)
      .filter(([, users]) => users.length > 0)
      .map(([emoji, users]) => ({
        emoji,
        count: users.length,
        users: users.map((u) => ({
          userId: u.userId,
          displayName: u.userName,
          avatarUrl: urlFromMap(avatarUrlMap, u.avatar) || "",
        })),
      }));

    return {
      messageId: params.messageId,
      roomId: message.roomId,
      reactions: reactionGroups,
    };
  }

  async deleteForMe(
    messageId: string,
    userId: string
  ): Promise<GeneralRoomMessage | null> {
    const message = await this.messageRepo.findById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    // Authorize against the message's OWN room (never a body-supplied communityId):
    // only an ACTIVE member of the room the message lives in may hide it. Mirrors
    // reactToMessage; NotFound so foreign-message existence isn't leaked.
    await this.assertActiveMemberOfMessageRoom(message, userId);

    if (normalizeMessageType(message.messageType) === "SYSTEM")
      throw new BadRequestError("CHAT_SYSTEM_MESSAGE_IMMUTABLE");

    await this.messageRepo.deleteForUser(messageId, userId);
    return this.messageRepo.findById(messageId);
  }

  async deleteForAll(
    messageId: string,
    userId: string
  ): Promise<GeneralRoomMessage | null> {
    const message = await this.messageRepo.findById(messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    // Authorize against the message's OWN room (never a body-supplied communityId):
    // the caller must be an ACTIVE member of the room the message lives in. NotFound
    // so foreign-message existence isn't leaked. (cross-room IDOR)
    const member = await this.assertActiveMemberOfMessageRoom(message, userId);

    if (normalizeMessageType(message.messageType) === "SYSTEM")
      throw new BadRequestError("CHAT_SYSTEM_MESSAGE_IMMUTABLE");

    // Sender can always delete their own message for everyone.
    // Others need admin or moderator role.
    if (message.sentBy !== userId) {
      if (!["admin", "moderator"].includes(member.role)) {
        throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
      }
    }

    return this.messageRepo.deleteForAll(messageId);
  }

  async report(params: {
    messageId: string;
    reporterId: string;
    reportReason: string;
  }): Promise<GeneralRoomMessage | null> {
    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    const member = await this.memberRepo.findByRoomAndUser(
      message.roomId,
      params.reporterId
    );
    if (!member || member.status !== "active")
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    return this.messageRepo.addReport(params.messageId, {
      userReportId: params.reporterId,
      userReportReason: params.reportReason,
    });
  }

  async pinMessage(params: {
    messageId: string;
    userId: string;
    roomId: string;
    communityId: string;
  }): Promise<{ pinnedIds: string[]; pinnedCount: number; pinnedAt: number }> {
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member || member.status !== "active")
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");
    if (!["admin", "moderator"].includes(member.role))
      throw new ForbiddenError("CHAT_INSUFFICIENT_PERMISSIONS");

    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (message.roomId !== params.roomId)
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (message.deletedForAll)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");
    if (normalizeMessageType(message.messageType) === "SYSTEM")
      throw new BadRequestError("CHAT_SYSTEM_MESSAGE_IMMUTABLE");

    const room = await this.roomRepo.findRoomById(params.roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    assertCommunityRoomWritable(room);
    const pinnedIds: string[] = Array.isArray(room.listPinedMessage)
      ? (room.listPinedMessage as string[])
      : [];

    if (pinnedIds.length >= env.PIN_LIMIT_PER_ROOM)
      throw new BadRequestError("CHAT_PIN_LIMIT_REACHED");

    if (pinnedIds.includes(params.messageId)) {
      return { pinnedIds, pinnedCount: pinnedIds.length, pinnedAt: Date.now() };
    }

    const newPinnedIds = [...pinnedIds, params.messageId];
    await this.roomRepo.updatePinnedMessages(params.roomId, newPinnedIds);

    // Telegram-style "{actor} pinned a message" SYSTEM line (best-effort).
    void this.systemMessageService?.post({
      communityId: params.communityId,
      systemMessageType: "PINNED_MESSAGE",
      metadata: { pinnedMessageId: params.messageId },
      triggeredByUserId: params.userId,
    });

    return {
      pinnedIds: newPinnedIds,
      pinnedCount: newPinnedIds.length,
      pinnedAt: Date.now(),
    };
  }

  /**
   * Per-message read receipt: advance the reader's read pointer to
   * `upToMessageId` and publish two Redis events:
   *   1. `community:<communityId>` → `community:message:read`  (room broadcast)
   *   2. `user:<readerId>`         → `community:read_sync`      (own-device sync)
   */
  async markMessageRead(params: {
    communityId: string;
    roomId: string;
    readerId: string;
    upToMessageId: string;
  }): Promise<{ ok: boolean; communityId: string; readAt: number }> {
    // Validate active membership.
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.readerId
    );
    if (!member || member.status !== "active") {
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");
    }

    // Fetch the message to get its createdAt (advanceReadPointer is forward-only).
    const message = await this.messageRepo.findById(params.upToMessageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    const now = new Date();
    // Advance read pointer (forward-only — noop if already at/past this message).
    await this.memberRepo
      .advanceReadPointer(
        params.roomId,
        params.readerId,
        params.upToMessageId,
        now
      )
      .catch((err: unknown) => {
        logger.warn(
          `CommunityMessageService|markMessageRead|advanceReadPointer failed: ${String(err)}`
        );
      });

    const readAt = now.getTime();
    const readPayload = {
      communityId: params.communityId,
      readerId: params.readerId,
      upToMessageId: params.upToMessageId,
      readAt,
    };

    // Broadcast to all community room members.
    redis
      .publish(
        `community:${params.communityId}`,
        JSON.stringify({ event: "community:message:read", data: readPayload })
      )
      .catch((err: unknown) => {
        logger.warn(
          `CommunityMessageService|markMessageRead|redis publish community failed: ${String(err)}`
        );
      });

    // Sync to reader's own other devices.
    redis
      .publish(
        `user:${params.readerId}`,
        JSON.stringify({
          event: "community:read_sync",
          data: {
            communityId: params.communityId,
            upToMessageId: params.upToMessageId,
            readAt,
          },
        })
      )
      .catch((err: unknown) => {
        logger.warn(
          `CommunityMessageService|markMessageRead|redis publish user failed: ${String(err)}`
        );
      });

    return { ok: true, communityId: params.communityId, readAt };
  }

  /**
   * Delivery receipt: validates that the recipient is an active member, then
   * broadcasts `community:message:delivered` on the community Redis channel so
   * connected clients (especially the sender) can update their delivery indicator.
   *
   * Community delivery state is inferred from RoomMember.joinedAt (no per-message
   * DB write — the GeneralRoomMessage schema has no deliveredTo column), so this
   * handler is purely a signal: "recipient has received up to this message".
   */
  async markMessageDelivered(params: {
    communityId: string;
    roomId: string;
    recipientId: string;
    upToMessageId: string;
  }): Promise<{ ok: boolean; communityId: string; deliveredAt: number }> {
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.recipientId
    );
    if (!member || member.status !== "active") {
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");
    }

    const deliveredAt = Date.now();

    redis
      .publish(
        `community:${params.communityId}`,
        JSON.stringify({
          event: "community:message:delivered",
          data: {
            communityId: params.communityId,
            recipientId: params.recipientId,
            upToMessageId: params.upToMessageId,
            deliveredAt,
          },
        })
      )
      .catch((err: unknown) => {
        logger.warn(
          `CommunityMessageService|markMessageDelivered|redis publish failed: ${String(err)}`
        );
      });

    return { ok: true, communityId: params.communityId, deliveredAt };
  }

  /**
   * Return the full grouped reaction list for a message. Validates active
   * membership and resolves avatar object-keys to presigned URLs.
   */
  async getMessageReactions(params: {
    messageId: string;
    communityId: string;
    requesterId: string;
  }): Promise<{
    messageId: string;
    communityId: string;
    reactions: Array<{
      emoji: string;
      count: number;
      users: Array<{ userId: string; displayName: string; avatar: string }>;
    }>;
  }> {
    const message = await this.messageRepo.findById(params.messageId);
    if (!message) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");

    // Validate active membership.
    const member = await this.memberRepo.findByRoomAndUser(
      message.roomId,
      params.requesterId
    );
    if (!member || member.status !== "active") {
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");
    }

    const raw = (message.reactions ?? {}) as Record<string, unknown>;
    const allAvatarKeys: string[] = [];
    const grouped: Array<{
      emoji: string;
      count: number;
      users: Array<{ userId: string; displayName: string; avatar: string }>;
    }> = [];

    for (const [emoji, list] of Object.entries(raw)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      const users = list.map((r) => {
        const reactor = (r ?? {}) as Record<string, unknown>;
        const avatar = (reactor.avatar as string) || "";
        if (avatar) allAvatarKeys.push(avatar);
        return {
          userId: (reactor.userId as string) || "",
          displayName:
            (reactor.userName as string) ||
            (reactor.displayName as string) ||
            "",
          avatar,
        };
      });
      grouped.push({ emoji, count: users.length, users });
    }

    // Refresh displayNames from live snapshots so renames are reflected.
    const allUserIds = [
      ...new Set(
        grouped.flatMap((g) => g.users.map((u) => u.userId).filter(Boolean))
      ),
    ];
    const snaps =
      allUserIds.length > 0
        ? await this.userSnapshotService.getUserSnapshotsMap(
            allUserIds,
            this.cacheRepo
          )
        : new Map<string, Record<string, unknown>>();

    const urlMap = await resolveMediaUrlMap(allAvatarKeys);
    const resolved = grouped.map((g) => ({
      ...g,
      users: g.users.map((u) => {
        const snap = snaps.get(u.userId);
        return {
          ...u,
          displayName: (snap?.displayName as string) || u.displayName,
          avatar: urlFromMap(urlMap, u.avatar) || u.avatar,
        };
      }),
    }));

    return {
      messageId: params.messageId,
      communityId: params.communityId,
      reactions: resolved,
    };
  }

  /**
   * Forward a community message to another community room. Fetches the source
   * message, verifies the sender is an ACTIVE member of the target room, then
   * delegates to `sendMessage` so all live effects (broadcast, push, bump-to-top)
   * run automatically via the existing send path.
   */
  async forwardMessage(params: {
    sourceMessageId: string;
    sourceCommunityId: string;
    targetCommunityId: string;
    targetRoomId: string;
    senderId: string;
    clientMessageId: string;
  }): Promise<{ messageId: string; roomId: string; sentAt: number }> {
    const source = await this.messageRepo.findById(params.sourceMessageId);
    if (!source) throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    if (source.deletedForAll)
      throw new BadRequestError("CHAT_MESSAGE_ALREADY_DELETED");

    // Validate sender is ACTIVE member of the target room.
    const targetMember = await this.memberRepo.findByRoomAndUser(
      params.targetRoomId,
      params.senderId
    );
    if (!targetMember || targetMember.status !== "active") {
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");
    }

    // Fetch sender snapshot for display name + avatar.
    const snaps = await this.userSnapshotService.getUserSnapshotsMap(
      [params.senderId],
      this.cacheRepo
    );
    const snap = snaps.get(params.senderId);
    const senderName = (snap?.displayName as string) || "";
    const senderAvatar = (snap?.avatar as string) || "";

    const saved = await this.sendMessage({
      roomId: params.targetRoomId,
      sentBy: params.senderId,
      senderName,
      senderAvatar,
      message: source.message ?? "",
      messageType: normalizeMessageType(source.messageType),
      clientMessageId: params.clientMessageId,
      attachments: Array.isArray(source.attachments)
        ? (source.attachments as Array<Record<string, unknown>>)
        : undefined,
    });

    const sentAt =
      saved.createdAt instanceof Date ? saved.createdAt.getTime() : Date.now();

    return { messageId: saved.id, roomId: saved.roomId, sentAt };
  }

  async unpinMessage(params: {
    messageId: string;
    userId: string;
    roomId: string;
    communityId: string;
  }): Promise<{ pinnedIds: string[]; pinnedCount: number }> {
    const member = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member || member.status !== "active")
      throw new ForbiddenError("CHAT_NOT_A_MEMBER");
    if (!["admin", "moderator"].includes(member.role))
      throw new ForbiddenError("CHAT_INSUFFICIENT_PERMISSIONS");

    const room = await this.roomRepo.findRoomById(params.roomId);
    if (!room) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    assertCommunityRoomWritable(room);
    const pinnedIds: string[] = Array.isArray(room.listPinedMessage)
      ? (room.listPinedMessage as string[])
      : [];

    if (!pinnedIds.includes(params.messageId))
      throw new NotFoundError("CHAT_PIN_NOT_FOUND");

    const targetMsg = await this.messageRepo.findById(params.messageId);
    if (targetMsg && normalizeMessageType(targetMsg.messageType) === "SYSTEM")
      throw new BadRequestError("CHAT_SYSTEM_MESSAGE_IMMUTABLE");

    const newPinnedIds = pinnedIds.filter((id) => id !== params.messageId);
    await this.roomRepo.updatePinnedMessages(params.roomId, newPinnedIds);

    // Telegram-style "{actor} unpinned a message" SYSTEM line (best-effort).
    void this.systemMessageService?.post({
      communityId: params.communityId,
      systemMessageType: "UNPINNED_MESSAGE",
      metadata: { pinnedMessageId: params.messageId },
      triggeredByUserId: params.userId,
    });

    return { pinnedIds: newPinnedIds, pinnedCount: newPinnedIds.length };
  }
}
