import type {
  PrismaClient,
  GroupRoom,
  Prisma,
} from "../generated/prisma/index.js";
import { withWriteConflictRetry } from "../lib/db-errors.js";
import {
  buildGroupSearchFilter,
  normalizeForSearch,
} from "../lib/group-search.util.js";
import { newerSnapshotWhere } from "../lib/last-activity-guard.js";
import { listRowIdentity } from "../lib/list-row-identity.js";
import { buildRoomKeysetWhere } from "../lib/pagination.js";
import {
  autoDeletePolicyUpdatePipeline,
  type AutoDeleteMode,
} from "../lib/auto-delete.js";

/** Clone a date pinned to the end of its UTC calendar day (inclusive upper bound). */
function endOfDay(d: Date): Date {
  const end = new Date(d);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}

export class GroupRoomRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    roomId: string;
    name: string;
    createdBy: string;
    [key: string]: unknown;
  }): Promise<GroupRoom> {
    return this.prisma.groupRoom.create({
      data: {
        roomId: data.roomId,
        type: (data.type as string) ?? "GROUP",
        name: data.name,
        normalizedName: normalizeForSearch(data.name),
        avatar: (data.avatar as string) ?? "",
        description: (data.description as string) ?? "",
        createdBy: data.createdBy,
        status: (data.status as string) ?? "ACTIVE",
        memberLimit: (data.memberLimit as number) ?? 50,
        memberCount: (data.memberCount as number) ?? 1,
        settings: (data.settings as object) ?? {
          allowMemberInviteLink: true,
          allowMemberSendInviteLink: true,
          allowReply: true,
          allowPin: true,
        },
        lastMessageId: (data.lastMessageId as string) ?? null,
        lastMessageAt: (data.lastMessageAt as Date) ?? null,
        lastMessagePreview: (data.lastMessagePreview as object) ?? null,
        pinnedCount: (data.pinnedCount as number) ?? 0,
        lastPinnedAt: (data.lastPinnedAt as Date) ?? null,
        disbandedAt: (data.disbandedAt as Date) ?? null,
        disbandedBy: (data.disbandedBy as string) ?? null,
      },
    });
  }

  /** Count of active group rooms — admin dashboard aggregate. */
  async countActive(): Promise<number> {
    return this.prisma.groupRoom.count({ where: { status: "ACTIVE" } });
  }

  async allocateSequence(roomId: string): Promise<number> {
    // Bursty concurrent sends all `$inc` the same GroupRoom document; retry the
    // transient Mongo write-conflict (Prisma P2034) so fast/parallel sends don't
    // fail with a user-visible SERVICE_ERROR. See withWriteConflictRetry.
    const r = await withWriteConflictRetry(() =>
      this.prisma.groupRoom.update({
        where: { roomId },
        data: { lastSequence: { increment: 1 } },
        select: { lastSequence: true },
      })
    );
    return r.lastSequence;
  }

  /**
   * {@link allocateSequence} that also hands back the room row the `$inc`
   * already read. The send path needs the room's auto-delete timer to stamp the
   * message it is about to insert; taking it off this write costs nothing,
   * whereas a separate `findByRoomId` would add a round trip to every send —
   * and a timer read AFTER the allocation could race a concurrent change.
   */
  async allocateSequenceWithRoom(
    roomId: string
  ): Promise<{ sequenceNumber: number; room: GroupRoom }> {
    const room = await withWriteConflictRetry(() =>
      this.prisma.groupRoom.update({
        where: { roomId },
        data: { lastSequence: { increment: 1 } },
      })
    );
    return { sequenceNumber: room.lastSequence, room };
  }

  /**
   * Set/change/clear THE group's auto-delete timer. One record for the whole
   * room (not a per-member map): every member's messages follow it, so there is
   * nothing to merge. `userId` is recorded only as who last changed it — the
   * permission check lives in the service.
   */
  /**
   * Store THE group's timer, allocate its policy version and record the restamp
   * intent in one atomic write — the exact mirror of
   * `PrivateRoomRepository.setAutoDelete`; read its comment for the reasoning.
   */
  async setAutoDelete(
    roomId: string,
    userId: string,
    setting: { mode: string; ttlSeconds: number | null }
  ): Promise<GroupRoom | null> {
    const res = (await this.prisma.$runCommandRaw({
      findAndModify: "group_rooms",
      query: { roomId },
      update: autoDeletePolicyUpdatePipeline({
        mode: setting.mode as AutoDeleteMode,
        ttlSeconds: setting.ttlSeconds,
        setBy: userId,
        setAt: new Date().toISOString(),
      }),
      new: true,
    } as unknown as Prisma.InputJsonObject)) as { value?: unknown } | null;
    return (res?.value as GroupRoom | undefined) ?? null;
  }

  /** Clear the restamp intent only if it still names this policy version. */
  async clearAutoDeleteRestampPending(
    roomId: string,
    policyVersion: number
  ): Promise<boolean> {
    const res = await this.prisma.groupRoom.updateMany({
      where: { roomId, autoDeleteRestampPending: policyVersion },
      data: { autoDeleteRestampPending: null },
    });
    return res.count > 0;
  }

  /** Groups whose policy is stored but whose enrolled rows were never moved. */
  async findPendingAutoDeleteRestamps(limit: number): Promise<GroupRoom[]> {
    return this.prisma.groupRoom.findMany({
      where: { autoDeleteRestampPending: { not: null } },
      take: limit,
    });
  }

  /**
   * Atomically allocate the next per-room CHANGE revision (Telegram `pts`).
   * Same atomic-`$inc` + write-conflict-retry pattern as `allocateSequence`, but on
   * `lastRevision` and bumped on EVERY content change (insert, edit, delete-for-everyone,
   * reaction) — not only on insert. Feeds the zero-loss `/changes` feed.
   */
  async allocateRevision(roomId: string): Promise<number> {
    const r = await withWriteConflictRetry(() =>
      this.prisma.groupRoom.update({
        where: { roomId },
        data: { lastRevision: { increment: 1 } },
        select: { lastRevision: true },
      })
    );
    return r.lastRevision;
  }

  /** Current room CHANGE high-water — the client seeds/compares its cursor against this. */
  async getRoomRevision(roomId: string): Promise<number> {
    const room = await this.prisma.groupRoom.findUnique({
      where: { roomId },
      select: { lastRevision: true },
    });
    return room?.lastRevision ?? 0;
  }

  async findByRoomId(roomId: string): Promise<GroupRoom | null> {
    return this.prisma.groupRoom.findUnique({ where: { roomId } });
  }

  async findActiveByRoomId(roomId: string): Promise<GroupRoom | null> {
    return this.prisma.groupRoom.findFirst({
      where: { roomId, status: "ACTIVE" },
    });
  }

  /**
   * Admin Group Management: resolve a single group by its roomId, whatever its
   * lifecycle status — a disbanded group must still open in the admin panel.
   * roomId is @unique, so this is the same single indexed lookup.
   */
  async adminFindByRoomId(roomId: string): Promise<GroupRoom | null> {
    return this.findByRoomId(roomId);
  }

  /**
   * Admin Group Management: filterable/sortable/paginated group list.
   * `status` is "" / "ACTIVE" (default, active only), "ALL" (no filter) or an
   * exact lifecycle value. `idsFromUserSearch` are roomIds whose OWNER matched a
   * free-text user search; they widen the `q` OR-clause so admins can find
   * groups by owner identity.
   */
  async adminList(params: {
    q?: string;
    status?: string;
    idsFromUserSearch?: string[] | null;
    fromDate?: Date;
    toDate?: Date;
    sortField: "createdAt" | "memberCount";
    sortDir: "asc" | "desc";
    skip: number;
    take: number;
  }): Promise<{ rows: GroupRoom[]; total: number }> {
    const {
      q,
      status,
      idsFromUserSearch,
      fromDate,
      toDate,
      sortField,
      sortDir,
      skip,
      take,
    } = params;

    const and: Array<Record<string, unknown>> = [];
    const statusFilter = (status || "ACTIVE").toUpperCase();
    if (statusFilter !== "ALL") and.push({ status: statusFilter });

    if (fromDate || toDate) {
      const createdAt: Record<string, Date> = {};
      if (fromDate) createdAt.gte = fromDate;
      if (toDate) createdAt.lte = endOfDay(toDate);
      and.push({ createdAt });
    }

    if (q) {
      // Same normalizer the in-app group search uses (AND-of-token-ORs), so the
      // admin box is never weaker than the product one. Wrapped in a single AND
      // branch — spreading it into the OR would turn it into match-any-token.
      // A punctuation-only q tokenizes to [] and `{AND: []}` matches everything,
      // hence the length guard.
      const nameFilter = buildGroupSearchFilter(q);
      and.push({
        OR: [
          ...(nameFilter.length ? [{ AND: nameFilter }] : []),
          { roomId: q },
          ...(idsFromUserSearch?.length
            ? [{ roomId: { in: idsFromUserSearch } }]
            : []),
        ],
      });
    }

    type FindArgs = Parameters<typeof this.prisma.groupRoom.findMany>[0];
    type WhereArg = NonNullable<FindArgs>["where"];
    const where = { AND: and } as WhereArg;

    const [rows, total] = await Promise.all([
      this.prisma.groupRoom.findMany({
        where,
        orderBy: [{ [sortField]: sortDir }, { roomId: sortDir }],
        skip,
        take,
      }),
      this.prisma.groupRoom.count({ where }),
    ]);

    return { rows, total };
  }

  async updateRoom(
    roomId: string,
    data: Record<string, unknown>
  ): Promise<GroupRoom | null> {
    // Keep the normalized search shadow in sync whenever the display name changes.
    const patch =
      typeof data.name === "string"
        ? { ...data, normalizedName: normalizeForSearch(data.name) }
        : data;
    return this.prisma.groupRoom.update({
      where: { roomId },
      data: patch as Parameters<typeof this.prisma.groupRoom.update>[0]["data"],
    });
  }

  async updateLastMessage(
    roomId: string,
    message: {
      _id: unknown;
      senderId: string | null;
      senderName: string;
      messageType: string;
      content: { text: string };
      createdAt: Date;
      /** Offline-first list identity (see lib/list-row-identity.ts). */
      clientMessageId?: string | null;
      sequenceNumber?: number | null;
      revision?: number | null;
    }
  ): Promise<number> {
    // Bursty concurrent sends/system-messages all write this same document;
    // retry the transient Mongo write-conflict (Prisma P2034) instead of
    // silently dropping the lastActivity bump — same reasoning as
    // allocateSequence/allocateRevision above.
    //
    // `updateMany` (not `update`) because the write is CONDITIONAL: it lands
    // only while this message is newer than the stored snapshot, ordered by
    // (lastMessageAt, seq). Five messages sent in a burst are five concurrent
    // handlers, so nothing made these writes arrive in send order and an older
    // one used to rewind the room's preview. Returns the matched count — 0
    // means a newer message already owns the snapshot, which is a success.
    // See lib/last-activity-guard.ts.
    const res = await withWriteConflictRetry(() =>
      this.prisma.groupRoom.updateMany({
        where: {
          roomId,
          ...newerSnapshotWhere(message.createdAt, message.sequenceNumber),
        },
        data: {
          lastMessageId: String(message._id),
          lastMessageAt: message.createdAt,
          lastMessageSeq: message.sequenceNumber ?? 0,
          lastMessagePreview: {
            text: message.content?.text || "",
            senderId: message.senderId,
            senderName: message.senderName,
            messageType: message.messageType,
            createdAt: message.createdAt,
            ...listRowIdentity({ ...message, id: String(message._id) }),
          },
        },
      })
    );
    return res.count;
  }

  /**
   * Overwrite the room's last-message snapshot after a delete-for-everyone
   * removes the current last message. Accepts null to clear (no visible messages
   * remain). Unlike updateLastMessage (new-send path), this does not require
   * a full message object and is not retried on write-conflict.
   */
  async setLastMessage(
    roomId: string,
    message: {
      id: string;
      senderId: string | null;
      senderName: string;
      content: { text: string };
      messageType: string;
      createdAt: Date;
      clientMessageId?: string | null;
      sequenceNumber?: number | null;
      revision?: number | null;
    } | null
  ): Promise<void> {
    await this.prisma.groupRoom.update({
      where: { roomId },
      data: message
        ? {
            lastMessageId: message.id,
            lastMessageAt: message.createdAt,
            // See PrivateRoomRepository.setLastMessage — keeps the tie-breaker
            // aligned with the message the room now previews.
            lastMessageSeq: message.sequenceNumber ?? 0,
            lastMessagePreview: {
              text: message.content?.text || "",
              senderId: message.senderId,
              senderName: message.senderName,
              messageType: message.messageType,
              createdAt: message.createdAt,
              ...listRowIdentity(message),
            },
          }
        : {
            lastMessageId: null,
            lastMessageAt: null,
            lastMessageSeq: null,
            lastMessagePreview: null as unknown as Prisma.InputJsonValue,
          },
    });
  }

  /**
   * Persist the reaction OVERLAY — see PrivateRoomRepository.setReactionActivity
   * for the full rationale (same fields, same semantics). Never touches
   * lastMessagePreview/lastMessageAt.
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
    await this.prisma.groupRoom.update({
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

  /** See PrivateRoomRepository.clearReactionActivityIfCurrent — identical semantics. */
  async clearReactionActivityIfCurrent(
    roomId: string,
    identity: { messageId: string; emoji: string; actorId: string }
  ): Promise<void> {
    await this.prisma.groupRoom.updateMany({
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

  async incMemberCount(roomId: string, inc: number): Promise<GroupRoom | null> {
    return this.prisma.groupRoom.update({
      where: { roomId },
      data: { memberCount: { increment: inc } },
    });
  }

  async incPinnedCount(
    roomId: string,
    inc: number,
    client: PrismaClient | Prisma.TransactionClient = this.prisma
  ): Promise<GroupRoom | null> {
    return client.groupRoom.update({
      where: { roomId },
      data: {
        pinnedCount: { increment: inc },
        ...(inc > 0 ? { lastPinnedAt: new Date() } : {}),
      },
    });
  }

  async disband(roomId: string, userId: string): Promise<GroupRoom | null> {
    return this.prisma.groupRoom.update({
      where: { roomId },
      data: {
        status: "DISBANDED",
        disbandedAt: new Date(),
        disbandedBy: userId,
      },
    });
  }

  async setArchived(roomId: string, userId: string): Promise<GroupRoom | null> {
    const existing = await this.prisma.groupRoom.findUnique({
      where: { roomId },
    });
    if (!existing) return null;

    const archivedBy = (existing.archivedBy ?? {}) as Record<string, unknown>;
    archivedBy[userId] = { archivedAt: new Date().toISOString() };

    return this.prisma.groupRoom.update({
      where: { roomId },
      data: { archivedBy: archivedBy as unknown as Prisma.InputJsonValue },
    });
  }

  async setUnarchived(
    roomId: string,
    userId: string
  ): Promise<GroupRoom | null> {
    const existing = await this.prisma.groupRoom.findUnique({
      where: { roomId },
    });
    if (!existing) return null;

    const archivedBy = (existing.archivedBy ?? {}) as Record<string, unknown>;
    delete archivedBy[userId];

    return this.prisma.groupRoom.update({
      where: { roomId },
      data: { archivedBy: archivedBy as unknown as Prisma.InputJsonValue },
    });
  }

  async getUserGroups(
    _userId: string,
    roomIds: string[],
    params: { limit: number; cursor?: string | null; q?: string }
  ): Promise<GroupRoom[]> {
    return this.prisma.groupRoom.findMany({
      where: {
        roomId: { in: roomIds },
        status: "ACTIVE",
        ...(params.cursor
          ? { lastMessageAt: { lt: new Date(params.cursor) } }
          : {}),
        ...(params.q ? { AND: buildGroupSearchFilter(params.q) } : {}),
      },
      orderBy: { lastMessageAt: "desc" },
      take: params.limit,
    });
  }

  async countUserGroups(roomIds: string[], q?: string): Promise<number> {
    return this.prisma.groupRoom.count({
      where: {
        roomId: { in: roomIds },
        status: "ACTIVE",
        ...(q ? { AND: buildGroupSearchFilter(q) } : {}),
      },
    });
  }

  /**
   * Lean `{roomId, lastMessageAt}` for a set of rooms — used by the service to
   * apply the per-user "delete conversation" (`clearedAt`) visibility filter in
   * memory before counting, since that cutoff lives on GroupMember, not GroupRoom.
   */
  async findLastMessageAtForRooms(
    roomIds: string[],
    q?: string
  ): Promise<Array<{ roomId: string; lastMessageAt: Date | null }>> {
    if (!roomIds.length) return [];
    return this.prisma.groupRoom.findMany({
      where: {
        roomId: { in: roomIds },
        status: "ACTIVE",
        ...(q ? { AND: buildGroupSearchFilter(q) } : {}),
      },
      select: { roomId: true, lastMessageAt: true },
    });
  }

  /**
   * Timestamp-bounded group fetch for the unified inbox.
   * - direction "before": lastMessageAt <= ts, newest-first (desc).
   * - direction "after" : lastMessageAt >= ts, oldest-first (asc).
   * Only ACTIVE groups the user belongs to (roomIds) with a lastMessageAt.
   */
  /**
   * User Search — groups restricted to an explicit id set the caller already
   * resolved from the viewer's own memberships, optionally filtered by name,
   * newest activity first. There is deliberately no "every other group"
   * variant: group existence must never imply group visibility, so the id set
   * is always derived from the viewer's relationship to the group.
   */
  async searchInRoomIds(
    roomIds: string[],
    q: string | undefined,
    limit: number
  ): Promise<GroupRoom[]> {
    if (roomIds.length === 0) return [];
    return this.prisma.groupRoom.findMany({
      where: {
        roomId: { in: roomIds },
        status: "ACTIVE",
        ...(q ? { AND: buildGroupSearchFilter(q) } : {}),
      },
      orderBy: { lastMessageAt: "desc" },
      take: limit,
    });
  }

  /** User Search — resolve specific roomIds (e.g. Recent group targets). */
  async findManyByRoomIds(roomIds: string[]): Promise<GroupRoom[]> {
    if (roomIds.length === 0) return [];
    return this.prisma.groupRoom.findMany({
      where: { roomId: { in: roomIds }, status: "ACTIVE" },
    });
  }

  async getInboxGroups(params: {
    roomIds: string[];
    direction: "before" | "after";
    ts: Date;
    /** V2 keyset tiebreaker parsed from a compound "<ms>_<roomId>" cursor. */
    boundaryId?: string | null;
    /** V1 inclusive bound (default); V2 passes false for a strict keyset. */
    inclusive?: boolean;
    limit: number;
  }): Promise<GroupRoom[]> {
    const dir = params.direction === "before" ? "desc" : "asc";
    return this.prisma.groupRoom.findMany({
      where: {
        roomId: { in: params.roomIds },
        status: "ACTIVE",
        ...buildRoomKeysetWhere(params),
      },
      orderBy: [{ lastMessageAt: dir }, { roomId: dir }],
      take: params.limit,
    });
  }
}
