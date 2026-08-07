import type {
  PrismaClient,
  PrivateRoom,
  Prisma,
} from "../generated/prisma/index.js";
import { withWriteConflictRetry } from "../lib/db-errors.js";
import { buildRoomKeysetWhere } from "../lib/pagination.js";
import { isObjectId } from "../lib/object-id.js";

// ponytail: post-fetch delete-for-me filter. Reappears when a newer message
// arrives after the user's deletion timestamp (Telegram-style). Dynamic-key
// Json path filters on MongoDB+Prisma are unreliable, so filter in memory.
function isVisibleAfterDeleteForMe(
  room: { deletedFor?: unknown; lastMessageAt?: Date | null },
  userId: string
): boolean {
  const map = (room.deletedFor ?? {}) as Record<string, string>;
  const deletedAt = map[userId];
  if (!deletedAt) return true;
  const deletedMs = new Date(deletedAt).getTime();
  const lastMs = room.lastMessageAt ? room.lastMessageAt.getTime() : 0;
  return lastMs > deletedMs;
}

export class PrivateRoomRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByRoomId(
    roomId: string,
    _options?: { projection?: Record<string, number>; session?: unknown }
  ): Promise<PrivateRoom | null> {
    return this.prisma.privateRoom.findUnique({ where: { roomId } });
  }

  async allocateSequence(roomId: string): Promise<number> {
    // Bursty concurrent sends all `$inc` the same PrivateRoom document; retry
    // the transient Mongo write-conflict (Prisma P2034) so fast/parallel sends
    // don't fail with a user-visible SERVICE_ERROR. See withWriteConflictRetry.
    const r = await withWriteConflictRetry(() =>
      this.prisma.privateRoom.update({
        where: { roomId },
        data: { lastSequence: { increment: 1 } },
        select: { lastSequence: true },
      })
    );
    return r.lastSequence;
  }

  /**
   * `allocateSequence` that also hands back the room document the `$inc` just
   * touched. The send path used to read the SAME doc twice more per message —
   * once for the auto-delete settings, once to decide "is this the first
   * message" — three remote round trips to one document. The post-`$inc` doc
   * still carries the PRE-send `lastMessageAt` (the snapshot update happens
   * later), so both answers are already in here.
   */
  async allocateSequenceWithRoom(
    roomId: string
  ): Promise<{ sequenceNumber: number; revision: number; room: PrivateRoom }> {
    const block = await this.allocateSequenceBlock(roomId, 1);
    return {
      sequenceNumber: block.lastSequence,
      revision: block.lastRevision,
      room: block.room,
    };
  }

  /**
   * Reserve `count` consecutive sequence/revision numbers in ONE `$inc`.
   *
   * The counter update is a per-room serialization point — one network round
   * trip per message against a remote Mongo caps a single conversation at
   * ~1/RTT sends per second no matter how much concurrency the callers have.
   * Handing out a block lets a burst pay for one round trip instead of `count`
   * of them. The returned values are the counters AFTER the increment, so the
   * reserved range is `lastSequence - count + 1 .. lastSequence`.
   */
  async allocateSequenceBlock(
    roomId: string,
    count: number
  ): Promise<{
    lastSequence: number;
    lastRevision: number;
    room: PrivateRoom;
  }> {
    const n = Math.max(1, count);
    const room = await withWriteConflictRetry(() =>
      this.prisma.privateRoom.update({
        where: { roomId },
        data: {
          lastSequence: { increment: n },
          lastRevision: { increment: n },
        },
      })
    );
    return {
      lastSequence: room.lastSequence,
      lastRevision: room.lastRevision,
      room,
    };
  }

  /**
   * Atomically allocate the next per-room CHANGE revision (Telegram `pts`).
   * Same atomic-`$inc` + write-conflict-retry pattern as `allocateSequence`, but on
   * `lastRevision` and bumped on EVERY content change (insert, edit, delete-for-everyone,
   * reaction) — not only on insert. Feeds the zero-loss `/changes` feed.
   */
  async allocateRevision(roomId: string): Promise<number> {
    const r = await withWriteConflictRetry(() =>
      this.prisma.privateRoom.update({
        where: { roomId },
        data: { lastRevision: { increment: 1 } },
        select: { lastRevision: true },
      })
    );
    return r.lastRevision;
  }

  /** Current room CHANGE high-water — the client seeds/compares its cursor against this. */
  async getRoomRevision(roomId: string): Promise<number> {
    const room = await this.prisma.privateRoom.findUnique({
      where: { roomId },
      select: { lastRevision: true },
    });
    return room?.lastRevision ?? 0;
  }

  async findByParticipantsKey(key: string): Promise<PrivateRoom | null> {
    return this.prisma.privateRoom.findUnique({
      where: { participantsKey: key },
    });
  }

  /**
   * Batch lookup for User Search: resolves many candidate peer rooms in one
   * indexed `$in` query against the @unique participantsKey column instead of
   * N single-key lookups.
   */
  async findByParticipantsKeys(keys: string[]): Promise<PrivateRoom[]> {
    if (keys.length === 0) return [];
    return this.prisma.privateRoom.findMany({
      where: { participantsKey: { in: keys } },
    });
  }

  /**
   * User Search: capped list of {peerId, roomId} pairs for every private
   * room the user participates in — used to classify search-matched users
   * into "has a room" (Chat) vs "doesn't" (Other) without a per-candidate
   * round trip. Ordered by lastMessageAt desc so a truncated cap keeps the
   * most-relevant (most-recently-active) rooms.
   */
  async findPeersForUser(
    userId: string,
    limit: number
  ): Promise<Array<{ peerId: string; roomId: string }>> {
    const rooms = await this.prisma.privateRoom.findMany({
      where: { participants: { has: userId } },
      select: { roomId: true, participants: true },
      orderBy: { lastMessageAt: "desc" },
      take: limit,
    });
    return rooms
      .map((r) => {
        const peerId = r.participants.find((p) => p !== userId);
        return peerId ? { peerId, roomId: r.roomId } : null;
      })
      .filter((x): x is { peerId: string; roomId: string } => x !== null);
  }

  /**
   * Presence fan-out: lean {roomId, peerId, lastMessage snapshot} for every
   * private room the user participates in — used to re-bump `conv:updated`
   * (with a fresh `isOffline`) to each peer when this user's presence flips.
   * Same participants-array query shape as {@link findPeersForUser}, just with
   * the last-message fields the bump payload needs.
   */
  async findRoomsForPresenceBump(
    userId: string,
    limit: number
  ): Promise<
    Array<{
      roomId: string;
      peerId: string;
      lastMessageId: string | null;
      lastMessage: unknown;
      lastMessageAt: Date | null;
    }>
  > {
    const rooms = await this.prisma.privateRoom.findMany({
      where: { participants: { has: userId } },
      select: {
        roomId: true,
        participants: true,
        lastMessageId: true,
        lastMessage: true,
        lastMessageAt: true,
      },
      orderBy: { lastMessageAt: "desc" },
      take: limit,
    });
    return rooms
      .map((r) => {
        const peerId = r.participants.find((p) => p !== userId);
        return peerId
          ? {
              roomId: r.roomId,
              peerId,
              lastMessageId: r.lastMessageId,
              lastMessage: r.lastMessage,
              lastMessageAt: r.lastMessageAt,
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }

  /**
   * Cheapest possible list of a user's rooms + their last message id — used by
   * the presence-connect delivered backfill. No participant list, no preview,
   * no ordering — just enough to walk and call markDeliveredUpTo per room.
   * 500 cap so a whale user's connect never blocks the presence recompute.
   */
  async findParticipatingRoomHeads(userId: string): Promise<
    Array<{
      roomId: string;
      lastMessageId: string | null;
      participants: string[];
    }>
  > {
    return this.prisma.privateRoom.findMany({
      where: { participants: { has: userId } },
      select: { roomId: true, lastMessageId: true, participants: true },
      take: 500,
    });
  }

  async create(data: {
    roomId: string;
    participants: string[];
    participantsKey: string;
    [key: string]: unknown;
  }): Promise<PrivateRoom> {
    return this.prisma.privateRoom.create({
      data: {
        roomId: data.roomId,
        participants: data.participants,
        participantsKey: data.participantsKey,
        lastMessageId: (data.lastMessageId as string) ?? null,
        lastMessageAt: (data.lastMessageAt as Date) ?? null,
        lastMessage: (data.lastMessage as object) ?? undefined,
        unreadCountByUser: (data.unreadCountByUser as object) ?? {},
        lastReadAtByUser: (data.lastReadAtByUser as object) ?? {},
        lastReadMessageIdByUser: (data.lastReadMessageIdByUser as object) ?? {},
        hasUnreadByUser: (data.hasUnreadByUser as object) ?? {},
        firstUnreadMessageIdByUser:
          (data.firstUnreadMessageIdByUser as object) ?? {},
        lastUnreadMessageIdByUser:
          (data.lastUnreadMessageIdByUser as object) ?? {},
        lastUnreadPreviewByUser: (data.lastUnreadPreviewByUser as object) ?? {},
        blockedBy: (data.blockedBy as object) ?? [],
        deletedFor: (data.deletedFor as object) ?? {},
        clearFor: (data.clearFor as object) ?? {},
        pinnedCount: (data.pinnedCount as number) ?? 0,
        lastPinnedAt: (data.lastPinnedAt as Date) ?? null,
      },
    });
  }

  async getConversationList(params: {
    userId: string;
    limit: number;
    cursor?: string | null;
  }): Promise<PrivateRoom[]> {
    const rows = await this.prisma.privateRoom.findMany({
      where: {
        participants: { has: params.userId },
        lastMessageAt: params.cursor
          ? { lt: new Date(params.cursor), not: null }
          : { not: null },
      },
      orderBy: { lastMessageAt: "desc" },
      take: params.limit,
    });
    return rows.filter((r) => isVisibleAfterDeleteForMe(r, params.userId));
  }

  async countConversations(userId: string): Promise<number> {
    // Approximate; excludes rooms fully hidden by this user's delete-for-me.
    const rows = await this.prisma.privateRoom.findMany({
      where: { participants: { has: userId }, lastMessageAt: { not: null } },
      select: { deletedFor: true, lastMessageAt: true },
    });
    return rows.filter((r) => isVisibleAfterDeleteForMe(r, userId)).length;
  }

  /**
   * Total unread private messages across every room the user's in — for the
   * Chats nav badge. Same unbounded shape as countConversations (a badge
   * total must cover every room, not one inbox page) plus the exact
   * `unreadByUser[userId] ?? 0` read PrivateRoomService.toPrivateItem already
   * uses per-row, just summed here instead of listed.
   */
  async sumUnreadForUser(userId: string): Promise<number> {
    const rows = await this.prisma.privateRoom.findMany({
      where: { participants: { has: userId }, lastMessageAt: { not: null } },
      select: {
        deletedFor: true,
        lastMessageAt: true,
        unreadCountByUser: true,
      },
    });
    return rows
      .filter((r) => isVisibleAfterDeleteForMe(r, userId))
      .reduce((sum, r) => {
        const unreadByUser = (r.unreadCountByUser ?? {}) as Record<
          string,
          number
        >;
        return sum + (unreadByUser[userId] ?? 0);
      }, 0);
  }

  /**
   * Timestamp-bounded conversation fetch for the unified inbox.
   * - direction "before": lastMessageAt <= ts, newest-first (desc).
   * - direction "after" : lastMessageAt >= ts, oldest-first (asc).
   * Rooms without a lastMessageAt are excluded (no position in a time-ordered
   * list), matching getConversationList.
   */
  async getInboxConversations(params: {
    userId: string;
    direction: "before" | "after";
    ts: Date;
    /** V2 keyset tiebreaker parsed from a compound "<ms>_<roomId>" cursor. */
    boundaryId?: string | null;
    /** V1 inclusive bound (default); V2 passes false for a strict keyset. */
    inclusive?: boolean;
    limit: number;
  }): Promise<PrivateRoom[]> {
    const dir = params.direction === "before" ? "desc" : "asc";
    const rows = await this.prisma.privateRoom.findMany({
      where: {
        participants: { has: params.userId },
        ...buildRoomKeysetWhere(params),
      },
      orderBy: [{ lastMessageAt: dir }, { roomId: dir }],
      take: params.limit,
    });
    return rows.filter((r) => isVisibleAfterDeleteForMe(r, params.userId));
  }

  async updateRoomOnNewMessage(params: {
    roomId: string;
    message: {
      _id: string;
      content: unknown;
      senderId: string;
      messageType: string;
      systemEvent?: string | null;
      systemData?: unknown;
      createdAt: Date;
    };
    receiverId: string;
    /** How many unread rows this send contributes (albums > 1). */
    unreadIncrement?: number;
  }): Promise<PrivateRoom | null> {
    // ONE atomic findAndModify: `$inc` the receiver's unread counter and `$set`
    // the snapshot fields by dotted path, so nothing is read first and two
    // concurrent sends to the same room can never clobber each other. The old
    // read-modify-write (findUnique + update, retried on WriteConflict) was the
    // send path's throughput wall: under a burst every writer collided with
    // every other one, each retry re-read the doc, and this single step went
    // from ~1.4s to >20s at ~17 sends/s — long enough to blow the gateway's
    // gRPC breaker and fail sends that had already been persisted.
    const { roomId, message, receiverId } = params;
    const now = message.createdAt || new Date();
    const unreadIncrement = params.unreadIncrement ?? 1;

    const lastMessage = {
      content: message.content,
      senderId: message.senderId,
      messageType: message.messageType,
      systemEvent: message.systemEvent || null,
      systemData: message.systemData || null,
      createdAt: now.toISOString(),
    };

    const set: Record<string, unknown> = {
      lastMessageId: { $oid: message._id },
      lastMessageAt: { $date: now.toISOString() },
      lastMessage,
      updatedAt: { $date: now.toISOString() },
    };
    const inc: Record<string, number> = {};
    if (unreadIncrement > 0) {
      inc[`unreadCountByUser.${receiverId}`] = unreadIncrement;
      set[`hasUnreadByUser.${receiverId}`] = true;
      set[`lastUnreadMessageIdByUser.${receiverId}`] = message._id;
      set[`lastUnreadPreviewByUser.${receiverId}`] = {
        ...lastMessage,
        createdAt: { $date: now.toISOString() },
        messageId: message._id,
      };
    }

    const update = (Object.keys(inc).length
      ? { $set: set, $inc: inc }
      : { $set: set }) as unknown as Prisma.InputJsonObject;
    const res = (await this.prisma.$runCommandRaw({
      // Raw commands address the MONGO COLLECTION, not the Prisma model —
      // PrivateRoom is @@map'd to `private_rooms`. A wrong name here does not
      // error: findAndModify on a missing collection returns {value: null}, so
      // every room snapshot write (lastMessageAt/lastMessage/unread) silently
      // no-ops and the conversation never enters the inbox.
      findAndModify: "private_rooms",
      query: { roomId },
      update,
      new: true,
    } as unknown as Prisma.InputJsonObject)) as { value?: unknown } | null;

    return (res?.value as PrivateRoom | undefined) ?? null;
  }

  async markReadUpTo(params: {
    roomId: string;
    userId: string;
    upToMessageId: string;
  }): Promise<PrivateRoom | null> {
    // See updateRoomOnNewMessage: same read-modify-write race on the JSON
    // unread fields, same fix.
    return withWriteConflictRetry(() => this.doMarkReadUpTo(params));
  }

  private async doMarkReadUpTo(params: {
    roomId: string;
    userId: string;
    upToMessageId: string;
  }): Promise<PrivateRoom | null> {
    const { roomId, userId, upToMessageId } = params;
    const now = new Date();

    const existing = await this.prisma.privateRoom.findUnique({
      where: { roomId },
    });
    if (!existing) return null;

    // Guard against optimistic client ids ("tmp-…") — Prisma throws on non-ObjectId lookups and
    // writing a temp id into the read pointer would break subsequent reads for the same user.
    if (!isObjectId(upToMessageId)) return existing;

    const lastReadMessageIdByUser = (existing.lastReadMessageIdByUser ??
      {}) as Record<string, string>;

    // Forward-only: a read pointer must never move backward (multi-device — a second device that
    // read to an OLDER message would otherwise regress the pointer and wrongly re-zero unread).
    const upToSeq = (
      await this.prisma.privateMessage.findUnique({
        where: { id: upToMessageId },
        select: { sequenceNumber: true },
      })
    )?.sequenceNumber;
    const currentReadId = lastReadMessageIdByUser[userId];
    if (upToSeq != null && currentReadId && isObjectId(currentReadId)) {
      const currentSeq = (
        await this.prisma.privateMessage.findUnique({
          where: { id: currentReadId },
          select: { sequenceNumber: true },
        })
      )?.sequenceNumber;
      if (currentSeq != null && upToSeq <= currentSeq) return existing;
    }

    // Accurate remaining unread = inbound countable messages strictly newer
    // than the boundary (reading to a non-latest message must leave unread > 0,
    // not hard-zero). Exclude SYSTEM / countInUnread:false so call-ended and
    // other non-badge rows cannot leave a phantom unread after a full catch-up.
    const remainingUnread =
      upToSeq != null
        ? await this.prisma.privateMessage.count({
            where: {
              roomId,
              senderId: { not: userId },
              isDeleted: false,
              sequenceNumber: { gt: upToSeq },
              NOT: { countInUnread: false },
              messageType: { not: "SYSTEM" },
              systemEvent: null,
            },
          })
        : 0;

    const unreadCountByUser = (existing.unreadCountByUser ?? {}) as Record<
      string,
      number
    >;
    unreadCountByUser[userId] = remainingUnread;

    const lastReadAtByUser = (existing.lastReadAtByUser ?? {}) as Record<
      string,
      string
    >;
    lastReadAtByUser[userId] = now.toISOString();

    lastReadMessageIdByUser[userId] = upToMessageId;

    const hasUnread = remainingUnread > 0;
    const hasUnreadByUser = (existing.hasUnreadByUser ?? {}) as Record<
      string,
      boolean
    >;
    hasUnreadByUser[userId] = hasUnread;

    // Preview hints are only meaningful while unread remains; clear them once fully caught up.
    const firstUnreadMessageIdByUser = (existing.firstUnreadMessageIdByUser ??
      {}) as Record<string, string | null>;
    const lastUnreadMessageIdByUser = (existing.lastUnreadMessageIdByUser ??
      {}) as Record<string, string | null>;
    const lastUnreadPreviewByUser = (existing.lastUnreadPreviewByUser ??
      {}) as Record<string, unknown>;
    if (!hasUnread) {
      firstUnreadMessageIdByUser[userId] = null;
      lastUnreadMessageIdByUser[userId] = null;
      lastUnreadPreviewByUser[userId] = null;
    }

    return this.prisma.privateRoom.update({
      where: { roomId },
      data: {
        unreadCountByUser:
          unreadCountByUser as unknown as Prisma.InputJsonValue,
        lastReadAtByUser: lastReadAtByUser as unknown as Prisma.InputJsonValue,
        lastReadMessageIdByUser:
          lastReadMessageIdByUser as unknown as Prisma.InputJsonValue,
        hasUnreadByUser: hasUnreadByUser as unknown as Prisma.InputJsonValue,
        firstUnreadMessageIdByUser:
          firstUnreadMessageIdByUser as unknown as Prisma.InputJsonValue,
        lastUnreadMessageIdByUser:
          lastUnreadMessageIdByUser as unknown as Prisma.InputJsonValue,
        lastUnreadPreviewByUser:
          lastUnreadPreviewByUser as unknown as Prisma.InputJsonValue,
        updatedAt: now,
      },
    });
  }

  async decrementUnreadForMessage(params: {
    roomId: string;
    recipientId: string;
    messageId: string;
    messageCreatedAt: Date;
  }): Promise<void> {
    // See updateRoomOnNewMessage: same read-modify-write race, same fix.
    return withWriteConflictRetry(() =>
      this.doDecrementUnreadForMessage(params)
    );
  }

  private async doDecrementUnreadForMessage(params: {
    roomId: string;
    recipientId: string;
    messageId: string;
    messageCreatedAt: Date;
  }): Promise<void> {
    const existing = await this.prisma.privateRoom.findUnique({
      where: { roomId: params.roomId },
    });
    if (!existing) return;

    const lastReadAtByUser = (existing.lastReadAtByUser ?? {}) as Record<
      string,
      string
    >;
    const lastReadAt = lastReadAtByUser[params.recipientId]
      ? new Date(lastReadAtByUser[params.recipientId]!)
      : null;
    if (lastReadAt && lastReadAt >= params.messageCreatedAt) return;

    const unreadCountByUser = (existing.unreadCountByUser ?? {}) as Record<
      string,
      number
    >;
    unreadCountByUser[params.recipientId] = Math.max(
      0,
      (unreadCountByUser[params.recipientId] || 0) - 1
    );

    const hasUnreadByUser = (existing.hasUnreadByUser ?? {}) as Record<
      string,
      boolean
    >;
    hasUnreadByUser[params.recipientId] =
      (unreadCountByUser[params.recipientId] || 0) > 0;

    const lastUnreadMessageIdByUser = (existing.lastUnreadMessageIdByUser ??
      {}) as Record<string, string | null>;
    const lastUnreadPreviewByUser = (existing.lastUnreadPreviewByUser ??
      {}) as Record<string, unknown>;
    if (lastUnreadMessageIdByUser[params.recipientId] === params.messageId) {
      lastUnreadMessageIdByUser[params.recipientId] = null;
      lastUnreadPreviewByUser[params.recipientId] = null;
    }

    await this.prisma.privateRoom.update({
      where: { roomId: params.roomId },
      data: {
        unreadCountByUser:
          unreadCountByUser as unknown as Prisma.InputJsonValue,
        hasUnreadByUser: hasUnreadByUser as unknown as Prisma.InputJsonValue,
        lastUnreadMessageIdByUser:
          lastUnreadMessageIdByUser as unknown as Prisma.InputJsonValue,
        lastUnreadPreviewByUser:
          lastUnreadPreviewByUser as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async incPinnedCount(
    roomId: string,
    inc: number,
    client: PrismaClient | Prisma.TransactionClient = this.prisma
  ): Promise<PrivateRoom | null> {
    return client.privateRoom.update({
      where: { roomId },
      data: {
        pinnedCount: { increment: inc },
        ...(inc > 0 ? { lastPinnedAt: new Date() } : {}),
      },
    });
  }

  /**
   * Overwrite the room's last-message snapshot after a delete-for-everyone
   * removes the current last message. Accepts null to clear (no visible messages
   * remain). Unlike updateRoomOnNewMessage, this does not touch unread counts.
   */
  async setLastMessage(
    roomId: string,
    message: {
      id: string;
      senderId: string;
      content: unknown;
      messageType: string;
      createdAt: Date;
    } | null
  ): Promise<void> {
    await this.prisma.privateRoom.update({
      where: { roomId },
      data: message
        ? {
            lastMessageId: message.id,
            lastMessageAt: message.createdAt,
            lastMessage: {
              content: message.content as Prisma.InputJsonValue,
              senderId: message.senderId,
              messageType: message.messageType,
              createdAt: message.createdAt.toISOString(),
            } as unknown as Prisma.InputJsonValue,
          }
        : {
            lastMessageId: null,
            lastMessageAt: null,
            lastMessage: null as unknown as Prisma.InputJsonValue,
          },
    });
  }

  /**
   * Persist the reaction OVERLAY (see schema comment on PrivateRoom.reactionActivity*).
   * Never touches lastMessage/lastMessageAt — the canonical columns.
   */
  async setReactionActivity(
    roomId: string,
    data: {
      messageId: string;
      emoji: string;
      actorId: string;
      actorPreview: string;
      targetId: string | null;
      targetPreview: string | null;
      reactedAt: Date;
    }
  ): Promise<void> {
    await this.prisma.privateRoom.update({
      where: { roomId },
      data: {
        reactionActivityAt: data.reactedAt,
        reactionActivityMessageId: data.messageId,
        reactionActivityEmoji: data.emoji,
        reactionActivityActorId: data.actorId,
        reactionActivityActorPreview: data.actorPreview,
        reactionActivityTargetId: data.targetId,
        reactionActivityTargetPreview: data.targetPreview,
      },
    });
  }

  /**
   * Clear the reaction overlay IFF it still identifies the exact reaction being
   * removed (messageId+emoji+actorId) — a no-op otherwise, since that reaction
   * was never the one being shown. Mirrors community-service's identity-gated
   * clear semantics.
   */
  async clearReactionActivityIfCurrent(
    roomId: string,
    identity: { messageId: string; emoji: string; actorId: string }
  ): Promise<void> {
    await this.prisma.privateRoom.updateMany({
      where: {
        roomId,
        reactionActivityMessageId: identity.messageId,
        reactionActivityEmoji: identity.emoji,
        reactionActivityActorId: identity.actorId,
      },
      data: {
        reactionActivityAt: null,
        reactionActivityMessageId: null,
        reactionActivityEmoji: null,
        reactionActivityActorId: null,
        reactionActivityActorPreview: null,
        reactionActivityTargetId: null,
        reactionActivityTargetPreview: null,
      },
    });
  }

  async setDeletedFor(roomId: string, userId: string): Promise<void> {
    const existing = await this.prisma.privateRoom.findUnique({
      where: { roomId },
    });
    if (!existing) return;

    const deletedFor = (existing.deletedFor ?? {}) as Record<string, string>;
    deletedFor[userId] = new Date().toISOString();

    // Zero this user's unread state too — everything currently unread is about
    // to become invisible (before the cutoff), so it must not linger as a
    // phantom unread count once the room reappears on a future message.
    const unreadCountByUser = (existing.unreadCountByUser ?? {}) as Record<
      string,
      number
    >;
    unreadCountByUser[userId] = 0;
    const hasUnreadByUser = (existing.hasUnreadByUser ?? {}) as Record<
      string,
      boolean
    >;
    hasUnreadByUser[userId] = false;
    const firstUnreadMessageIdByUser = (existing.firstUnreadMessageIdByUser ??
      {}) as Record<string, string | null>;
    firstUnreadMessageIdByUser[userId] = null;
    const lastUnreadMessageIdByUser = (existing.lastUnreadMessageIdByUser ??
      {}) as Record<string, string | null>;
    lastUnreadMessageIdByUser[userId] = null;
    const lastUnreadPreviewByUser = (existing.lastUnreadPreviewByUser ??
      {}) as Record<string, unknown>;
    lastUnreadPreviewByUser[userId] = null;

    await this.prisma.privateRoom.update({
      where: { roomId },
      data: {
        deletedFor,
        unreadCountByUser:
          unreadCountByUser as unknown as Prisma.InputJsonValue,
        hasUnreadByUser: hasUnreadByUser as unknown as Prisma.InputJsonValue,
        firstUnreadMessageIdByUser:
          firstUnreadMessageIdByUser as unknown as Prisma.InputJsonValue,
        lastUnreadMessageIdByUser:
          lastUnreadMessageIdByUser as unknown as Prisma.InputJsonValue,
        lastUnreadPreviewByUser:
          lastUnreadPreviewByUser as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async setClearFor(roomId: string, userId: string): Promise<void> {
    const existing = await this.prisma.privateRoom.findUnique({
      where: { roomId },
    });
    if (!existing) return;

    const clearFor = (existing.clearFor ?? {}) as Record<string, string>;
    clearFor[userId] = new Date().toISOString();

    const unreadCountByUser = (existing.unreadCountByUser ?? {}) as Record<
      string,
      number
    >;
    unreadCountByUser[userId] = 0;
    const hasUnreadByUser = (existing.hasUnreadByUser ?? {}) as Record<
      string,
      boolean
    >;
    hasUnreadByUser[userId] = false;
    const firstUnreadMessageIdByUser = (existing.firstUnreadMessageIdByUser ??
      {}) as Record<string, string | null>;
    firstUnreadMessageIdByUser[userId] = null;
    const lastUnreadMessageIdByUser = (existing.lastUnreadMessageIdByUser ??
      {}) as Record<string, string | null>;
    lastUnreadMessageIdByUser[userId] = null;
    const lastUnreadPreviewByUser = (existing.lastUnreadPreviewByUser ??
      {}) as Record<string, unknown>;
    lastUnreadPreviewByUser[userId] = null;

    await this.prisma.privateRoom.update({
      where: { roomId },
      data: {
        clearFor,
        unreadCountByUser:
          unreadCountByUser as unknown as Prisma.InputJsonValue,
        hasUnreadByUser: hasUnreadByUser as unknown as Prisma.InputJsonValue,
        firstUnreadMessageIdByUser:
          firstUnreadMessageIdByUser as unknown as Prisma.InputJsonValue,
        lastUnreadMessageIdByUser:
          lastUnreadMessageIdByUser as unknown as Prisma.InputJsonValue,
        lastUnreadPreviewByUser:
          lastUnreadPreviewByUser as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async setMuted(
    roomId: string,
    userId: string,
    muteUntil: Date | null
  ): Promise<PrivateRoom | null> {
    const existing = await this.prisma.privateRoom.findUnique({
      where: { roomId },
    });
    if (!existing) return null;

    const mutedBy = (existing.mutedBy ?? {}) as Record<string, unknown>;
    mutedBy[userId] = {
      mutedAt: new Date().toISOString(),
      muteUntil: muteUntil ? muteUntil.toISOString() : null,
    };

    return this.prisma.privateRoom.update({
      where: { roomId },
      data: { mutedBy: mutedBy as unknown as Prisma.InputJsonValue },
    });
  }

  async setUnmuted(
    roomId: string,
    userId: string
  ): Promise<PrivateRoom | null> {
    const existing = await this.prisma.privateRoom.findUnique({
      where: { roomId },
    });
    if (!existing) return null;

    const mutedBy = (existing.mutedBy ?? {}) as Record<string, unknown>;
    delete mutedBy[userId];

    return this.prisma.privateRoom.update({
      where: { roomId },
      data: { mutedBy: mutedBy as unknown as Prisma.InputJsonValue },
    });
  }

  /**
   * Write ONE participant's auto-delete setting onto the per-user `autoDeleteBy`
   * map (same read-modify-write shape as `setMuted`). `mode: "OFF"` removes the
   * entry entirely so "never configured" and "explicitly turned off" stay one
   * state — the effective-timer resolution only ever asks "is there an entry".
   */
  async setAutoDelete(
    roomId: string,
    userId: string,
    setting: { mode: string; ttlSeconds: number | null } | null
  ): Promise<PrivateRoom | null> {
    const existing = await this.prisma.privateRoom.findUnique({
      where: { roomId },
    });
    if (!existing) return null;

    const autoDeleteBy = (existing.autoDeleteBy ?? {}) as Record<
      string,
      unknown
    >;
    if (!setting || setting.mode === "OFF") {
      delete autoDeleteBy[userId];
    } else {
      autoDeleteBy[userId] = {
        mode: setting.mode,
        ttlSeconds: setting.mode === "TIMER" ? setting.ttlSeconds : null,
        setAt: new Date().toISOString(),
      };
    }

    return this.prisma.privateRoom.update({
      where: { roomId },
      data: { autoDeleteBy: autoDeleteBy as unknown as Prisma.InputJsonValue },
    });
  }

  async setArchived(
    roomId: string,
    userId: string
  ): Promise<PrivateRoom | null> {
    const existing = await this.prisma.privateRoom.findUnique({
      where: { roomId },
    });
    if (!existing) return null;

    const archivedBy = (existing.archivedBy ?? {}) as Record<string, unknown>;
    archivedBy[userId] = { archivedAt: new Date().toISOString() };

    return this.prisma.privateRoom.update({
      where: { roomId },
      data: { archivedBy: archivedBy as unknown as Prisma.InputJsonValue },
    });
  }

  async setUnarchived(
    roomId: string,
    userId: string
  ): Promise<PrivateRoom | null> {
    const existing = await this.prisma.privateRoom.findUnique({
      where: { roomId },
    });
    if (!existing) return null;

    const archivedBy = (existing.archivedBy ?? {}) as Record<string, unknown>;
    delete archivedBy[userId];

    return this.prisma.privateRoom.update({
      where: { roomId },
      data: { archivedBy: archivedBy as unknown as Prisma.InputJsonValue },
    });
  }
}
