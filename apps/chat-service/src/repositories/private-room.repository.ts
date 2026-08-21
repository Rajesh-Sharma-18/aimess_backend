import type {
  PrismaClient,
  PrivateRoom,
  Prisma,
} from "../generated/prisma/index.js";
import { withWriteConflictRetry } from "../lib/db-errors.js";
import { newerSnapshotMongoQuery } from "../lib/last-activity-guard.js";
import { listRowIdentity } from "../lib/list-row-identity.js";
import { buildRoomKeysetWhere } from "../lib/pagination.js";
import { isObjectId } from "../lib/object-id.js";
import { UNREAD_COUNTABLE_RAW_MATCH } from "../lib/unread-count.js";
import {
  autoDeletePolicyUpdatePipeline,
  type AutoDeleteMode,
} from "../lib/auto-delete.js";

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
        // Profile default snapshot, taken ONCE at creation (see
        // `ensurePrivateRoom`). Absent => the room starts Off. From here the
        // room policy is independent: either participant may change it, and a
        // later change to the account default never rewrites this room.
        autoDelete: (data.autoDelete as object) ?? undefined,
        autoDeletePolicyVersion: data.autoDelete ? 1 : 0,
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
      /** Offline-first list identity (see lib/list-row-identity.ts). Optional so
       *  every existing caller keeps compiling; absent ⇒ null/0 defaults. */
      clientMessageId?: string | null;
      sequenceNumber?: number | null;
      revision?: number | null;
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
    // No resolved recipient ⇒ no unread bucket to credit. The dotted paths below
    // are built by string concatenation, so an empty `receiverId` silently wrote
    // `unreadCountByUser.""` (and `hasUnreadByUser.""`, …) — a bucket no viewer
    // ever reads, while the real peer's badge never moved. Every such write is
    // one permanently lost unread. Callers all resolve the peer from the room
    // now (`privateRoomPeerId`, dc55e7a4), but this is the single choke point
    // every private send passes through, so the guard belongs here.
    const unreadIncrement = receiverId ? (params.unreadIncrement ?? 1) : 0;

    const lastMessage = {
      content: message.content,
      senderId: message.senderId,
      messageType: message.messageType,
      systemEvent: message.systemEvent || null,
      systemData: message.systemData || null,
      createdAt: now.toISOString(),
      ...listRowIdentity({ ...message, id: message._id }),
    };

    const set: Record<string, unknown> = {
      lastMessageId: { $oid: message._id },
      lastMessageAt: { $date: now.toISOString() },
      lastMessageSeq: message.sequenceNumber ?? 0,
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
    // Raw commands address the MONGO COLLECTION, not the Prisma model —
    // PrivateRoom is @@map'd to `private_rooms`. A wrong name here does not
    // error: findAndModify on a missing collection returns {value: null}, so
    // every room snapshot write (lastMessageAt/lastMessage/unread) silently
    // no-ops and the conversation never enters the inbox.
    const runFindAndModify = async (
      query: Record<string, unknown>,
      body: Prisma.InputJsonObject
    ): Promise<PrivateRoom | null> => {
      const res = (await this.prisma.$runCommandRaw({
        findAndModify: "private_rooms",
        query,
        update: body,
        new: true,
      } as unknown as Prisma.InputJsonObject)) as { value?: unknown } | null;
      return (res?.value as PrivateRoom | undefined) ?? null;
    };

    // Fast path: one atomic step does BOTH the unread `$inc` and the snapshot
    // `$set`, gated on this message actually being newer than what is stored
    // (see lib/last-activity-guard.ts). Under a rapid burst two sends can land
    // out of order, and without the gate the older one silently rewound the
    // conversation's preview/timestamp to an intermediate message.
    const row = await runFindAndModify(
      {
        roomId,
        ...newerSnapshotMongoQuery(now, message.sequenceNumber),
      },
      update
    );
    if (row) return row;

    // The gate rejected this write: a NEWER message already owns the snapshot
    // (or the room does not exist). The unread increment is still owed — this
    // message is real and unread regardless of which one the list previews —
    // so re-issue the counter half alone. Returns null for a missing room.
    if (!Object.keys(inc).length) return null;
    const unreadOnly: Record<string, unknown> = { $inc: inc };
    const unreadSet: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(set)) {
      // Everything except the snapshot columns, i.e. the per-recipient unread
      // pointers — those describe THIS message and stay valid out of order.
      if (
        key === "lastMessageId" ||
        key === "lastMessageAt" ||
        key === "lastMessageSeq" ||
        key === "lastMessage" ||
        key.startsWith("lastUnreadMessageIdByUser.") ||
        key.startsWith("lastUnreadPreviewByUser.")
      ) {
        continue;
      }
      unreadSet[key] = value;
    }
    if (Object.keys(unreadSet).length) unreadOnly.$set = unreadSet;
    return runFindAndModify(
      { roomId },
      unreadOnly as unknown as Prisma.InputJsonObject
    );
  }

  async markReadUpTo(params: {
    roomId: string;
    userId: string;
    upToMessageId: string;
    /**
     * Does this reader currently give read receipts? Only then does the
     * EXPOSABLE pointer move with the read one. Off, it freezes where it stood
     * — which is what stops a read taken with the switch off from surfacing
     * later, since flipping the switch back on is a policy change, not a read.
     */
    givesReceipts: boolean;
  }): Promise<PrivateRoom | null> {
    // See updateRoomOnNewMessage: same read-modify-write race on the JSON
    // unread fields, same fix.
    return withWriteConflictRetry(() => this.doMarkReadUpTo(params));
  }

  private async doMarkReadUpTo(params: {
    roomId: string;
    userId: string;
    upToMessageId: string;
    givesReceipts: boolean;
  }): Promise<PrivateRoom | null> {
    const { roomId, userId, upToMessageId, givesReceipts } = params;
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
    // Bound to THIS room. A foreign message id used to resolve to a sequence
    // number from another conversation, which was then written into this room's
    // read pointer and used to compute its remaining-unread count.
    const upToSeq = (
      await this.prisma.privateMessage.findFirst({
        where: { id: upToMessageId, roomId },
        select: { sequenceNumber: true },
      })
    )?.sequenceNumber;
    if (upToSeq == null) return existing;
    const currentReadId = lastReadMessageIdByUser[userId];
    if (upToSeq != null && currentReadId && isObjectId(currentReadId)) {
      const currentSeq = (
        await this.prisma.privateMessage.findUnique({
          where: { id: currentReadId },
          select: { sequenceNumber: true },
        })
      )?.sequenceNumber;
      if (currentSeq != null && upToSeq <= currentSeq) {
        // The POINTER stays put (forward-only), but the stored counter can
        // still be stale: anything that credited it for a row at or below the
        // pointer is unreachable by a recount that never runs. Re-deriving it
        // here — from the pointer the reader already has, not from the
        // requested boundary — is the only self-heal a repeat read can offer,
        // and it is what stops a nav badge from outliving an empty Unread list.
        return this.reconcileUnreadAtPointer(
          existing,
          roomId,
          userId,
          currentSeq
        );
      }
    }

    // Accurate remaining unread = inbound countable messages strictly newer
    // than the boundary (reading to a non-latest message must leave unread > 0,
    // not hard-zero). Exclude SYSTEM / countInUnread:false so call-ended and
    // other non-badge rows cannot leave a phantom unread after a full catch-up.
    // aggregateRaw rather than a typed `count` for ONE reason: `deletedFor` is a
    // JSON map keyed by userId, and "this user hasn't hidden it" is only
    // expressible as a dotted `$exists` path. Group (`deletedForUserIds`) and
    // community (`deletedBy`) already exclude their delete-for-me equivalents in
    // the same way — private was the only surface still counting messages the
    // viewer had personally hidden, which would silently re-inflate the badge
    // right after a delete-for-me decremented it.
    const remainingUnread =
      upToSeq != null
        ? await this.countRemainingUnread(roomId, userId, upToSeq)
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
    // Captured before the advance below — the freeze branch needs the pointer
    // as it stood, which is also the receipt legacy rows already published.
    const priorReadAt = lastReadAtByUser[userId] ?? null;
    const priorReadMessageId = lastReadMessageIdByUser[userId] ?? null;
    lastReadAtByUser[userId] = now.toISOString();

    // The EXPOSABLE half of the pointer, written on EVERY accepted read —
    // receipts on or off. Once the key exists the legacy fallback in
    // `privateReceiptCursorOf` stops, so a reader with the switch off is frozen
    // at whatever they had already published instead of quietly keeping the old
    // always-expose behaviour. Read BEFORE `lastReadMessageIdByUser` is
    // advanced below: the freeze has to keep the PREVIOUS pointer, not this
    // read's target.
    const receiptReadMessageIdByUser = (existing.receiptReadMessageIdByUser ??
      {}) as Record<string, string | null>;
    const receiptReadAtByUser = (existing.receiptReadAtByUser ?? {}) as Record<
      string,
      string | null
    >;
    if (givesReceipts) {
      receiptReadMessageIdByUser[userId] = upToMessageId;
      // The instant of the RECEIPT, not of the message — that is what a viewer
      // who re-enabled receipts compares their own OFF → ON line against.
      receiptReadAtByUser[userId] = now.toISOString();
    } else {
      receiptReadMessageIdByUser[userId] =
        receiptReadMessageIdByUser[userId] ?? priorReadMessageId;
      receiptReadAtByUser[userId] = receiptReadAtByUser[userId] ?? priorReadAt;
    }

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
        receiptReadMessageIdByUser:
          receiptReadMessageIdByUser as unknown as Prisma.InputJsonValue,
        receiptReadAtByUser:
          receiptReadAtByUser as unknown as Prisma.InputJsonValue,
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

  /**
   * Inbound countable messages strictly newer than `upToSeq` that this user can
   * still see. Mirrors GroupMessageRepository.countUnreadAfter /
   * GeneralRoomMessageRepository.countUnreadAfter, including their
   * delete-for-me exclusion.
   */
  /**
   * Re-derive this user's unread counter from the read pointer they ALREADY
   * hold, without moving any pointer or republishing a receipt. Writes only
   * when the stored counter disagrees, so the common repeat-read (open a chat
   * that is already fully read) stays a pure read.
   */
  private async reconcileUnreadAtPointer(
    existing: PrivateRoom,
    roomId: string,
    userId: string,
    pointerSeq: number
  ): Promise<PrivateRoom> {
    const unreadCountByUser = (existing.unreadCountByUser ?? {}) as Record<
      string,
      number
    >;
    const stored = unreadCountByUser[userId] ?? 0;
    if (stored === 0) return existing;
    const remaining = await this.countRemainingUnread(
      roomId,
      userId,
      pointerSeq
    );
    if (remaining === stored) return existing;

    unreadCountByUser[userId] = remaining;
    const hasUnreadByUser = (existing.hasUnreadByUser ?? {}) as Record<
      string,
      boolean
    >;
    hasUnreadByUser[userId] = remaining > 0;
    const data: Record<string, unknown> = {
      unreadCountByUser: unreadCountByUser as unknown as Prisma.InputJsonValue,
      hasUnreadByUser: hasUnreadByUser as unknown as Prisma.InputJsonValue,
    };
    if (remaining === 0) {
      // Same cleanup the advancing path does — preview hints are only
      // meaningful while unread remains.
      const firstUnreadMessageIdByUser = (existing.firstUnreadMessageIdByUser ??
        {}) as Record<string, string | null>;
      const lastUnreadMessageIdByUser = (existing.lastUnreadMessageIdByUser ??
        {}) as Record<string, string | null>;
      const lastUnreadPreviewByUser = (existing.lastUnreadPreviewByUser ??
        {}) as Record<string, unknown>;
      firstUnreadMessageIdByUser[userId] = null;
      lastUnreadMessageIdByUser[userId] = null;
      lastUnreadPreviewByUser[userId] = null;
      data.firstUnreadMessageIdByUser =
        firstUnreadMessageIdByUser as unknown as Prisma.InputJsonValue;
      data.lastUnreadMessageIdByUser =
        lastUnreadMessageIdByUser as unknown as Prisma.InputJsonValue;
      data.lastUnreadPreviewByUser =
        lastUnreadPreviewByUser as unknown as Prisma.InputJsonValue;
    }
    return this.prisma.privateRoom.update({
      where: { roomId },
      data: data as Parameters<
        typeof this.prisma.privateRoom.update
      >[0]["data"],
    });
  }

  private async countRemainingUnread(
    roomId: string,
    userId: string,
    upToSeq: number
  ): Promise<number> {
    const result = (await this.prisma.privateMessage.aggregateRaw({
      pipeline: [
        {
          $match: {
            roomId,
            isDeleted: false,
            sequenceNumber: { $gt: upToSeq },
            senderId: { $ne: userId },
            // Personally hidden by this viewer ⇒ invisible to them ⇒ not unread.
            [`deletedFor.${userId}`]: { $exists: false },
            // Hard-exclude SYSTEM rows even if a legacy doc predates
            // countInUnread (UNREAD_COUNTABLE_RAW_MATCH treats missing as
            // countable).
            messageType: { $ne: "SYSTEM" },
            systemEvent: null,
            ...UNREAD_COUNTABLE_RAW_MATCH,
          },
        },
        { $count: "total" },
      ],
    })) as unknown as Array<{ total: number }>;
    return result[0]?.total ?? 0;
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
      clientMessageId?: string | null;
      sequenceNumber?: number | null;
      revision?: number | null;
    } | null
  ): Promise<void> {
    await this.prisma.privateRoom.update({
      where: { roomId },
      data: message
        ? {
            lastMessageId: message.id,
            lastMessageAt: message.createdAt,
            // Kept in step with lastMessageAt so the forward-only guard on the
            // NEXT send tie-breaks against the message actually being previewed.
            lastMessageSeq: message.sequenceNumber ?? 0,
            lastMessage: {
              content: message.content as Prisma.InputJsonValue,
              senderId: message.senderId,
              messageType: message.messageType,
              createdAt: message.createdAt.toISOString(),
              ...listRowIdentity(message),
            } as unknown as Prisma.InputJsonValue,
          }
        : {
            lastMessageId: null,
            lastMessageAt: null,
            lastMessageSeq: null,
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
   * map (same read-modify-write shape as `setMuted`).
   *
   * `mode: "OFF"` is STORED, not deleted: "explicitly turned off in this chat"
   * has to outrank the account-wide default (Settings → Chat → Auto-Delete),
   * which "never configured" does not. Passing `null` clears the entry back to
   * never-configured. Everything downstream reads through
   * `readAutoDeleteSetting`, which reports OFF for both.
   */
  /**
   * Write the CONVERSATION's one auto-delete timer. `userId` is recorded as who
   * changed it (for the system message and the wire), not as an owner — either
   * participant may set it and both then follow it.
   *
   * The legacy per-user `autoDeleteBy` map is cleared in the same update, so a
   * room can never be read through both models at once.
   */
  /**
   * Store THE conversation's timer, allocate its policy version, and record the
   * restamp intent — one atomic write. See
   * `lib/auto-delete.ts#autoDeletePolicyUpdatePipeline` for why all three have
   * to land together.
   *
   * `findAndModify` rather than a typed `update` because a pipeline update is
   * the only way to derive the new version from the stored one inside the same
   * write. Addresses the MONGO COLLECTION (`private_rooms`), not the Prisma
   * model — a wrong name here returns `{value: null}` rather than erroring.
   */
  async setAutoDelete(
    roomId: string,
    userId: string,
    setting: { mode: string; ttlSeconds: number | null }
  ): Promise<PrivateRoom | null> {
    const res = (await this.prisma.$runCommandRaw({
      findAndModify: "private_rooms",
      query: { roomId },
      update: autoDeletePolicyUpdatePipeline({
        mode: setting.mode as AutoDeleteMode,
        ttlSeconds: setting.ttlSeconds,
        setBy: userId,
        setAt: new Date().toISOString(),
        clearLegacyMap: true,
      }),
      new: true,
    } as unknown as Prisma.InputJsonObject)) as { value?: unknown } | null;
    return (res?.value as PrivateRoom | undefined) ?? null;
  }

  /**
   * Clear the restamp intent, but ONLY if it still names the version we just
   * finished restamping. A newer PUT that landed mid-restamp has already
   * written its own (higher) pending version and owes its own pass; clearing
   * unconditionally would drop that work on the floor.
   */
  async clearAutoDeleteRestampPending(
    roomId: string,
    policyVersion: number
  ): Promise<boolean> {
    const res = await this.prisma.privateRoom.updateMany({
      where: { roomId, autoDeleteRestampPending: policyVersion },
      data: { autoDeleteRestampPending: null },
    });
    return res.count > 0;
  }

  /** Rooms whose policy is stored but whose enrolled rows were never moved. */
  async findPendingAutoDeleteRestamps(limit: number): Promise<PrivateRoom[]> {
    return this.prisma.privateRoom.findMany({
      where: { autoDeleteRestampPending: { not: null } },
      take: limit,
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
