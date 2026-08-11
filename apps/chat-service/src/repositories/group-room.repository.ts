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
import { listRowIdentity } from "../lib/list-row-identity.js";
import { buildRoomKeysetWhere } from "../lib/pagination.js";

/** Clone a date pinned to the end of its calendar day (inclusive upper bound). */
function endOfDay(d: Date): Date {
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
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

  /** Admin Group Management: resolve a single ACTIVE group by its roomId. */
  async adminFindByRoomId(roomId: string): Promise<GroupRoom | null> {
    return this.findActiveByRoomId(roomId);
  }

  /**
   * Admin Group Management: filterable/sortable/paginated list of ACTIVE groups.
   * `idsFromUserSearch` are roomIds whose OWNER matched a free-text user search;
   * they widen the `q` OR-clause so admins can find groups by owner identity.
   */
  async adminList(params: {
    q?: string;
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
      idsFromUserSearch,
      fromDate,
      toDate,
      sortField,
      sortDir,
      skip,
      take,
    } = params;

    const and: Array<Record<string, unknown>> = [{ status: "ACTIVE" }];

    if (fromDate || toDate) {
      const createdAt: Record<string, Date> = {};
      if (fromDate) createdAt.gte = fromDate;
      if (toDate) createdAt.lte = endOfDay(toDate);
      and.push({ createdAt });
    }

    if (q) {
      and.push({
        OR: [
          { name: { contains: q, mode: "insensitive" } },
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
  ): Promise<GroupRoom | null> {
    // Bursty concurrent sends/system-messages all write this same document;
    // retry the transient Mongo write-conflict (Prisma P2034) instead of
    // silently dropping the lastActivity bump — same reasoning as
    // allocateSequence/allocateRevision above.
    return withWriteConflictRetry(() =>
      this.prisma.groupRoom.update({
        where: { roomId },
        data: {
          lastMessageId: String(message._id),
          lastMessageAt: message.createdAt,
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
   * User Search — groups the viewer is an ACTIVE member of, optionally
   * filtered by name, newest activity first.
   */
  async searchActiveForUser(
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

  /**
   * User Search — groups the viewer is NOT a member of (`excludeRoomIds`
   * covers both the viewer's own memberships and any ids already surfaced
   * elsewhere, e.g. Recent), optionally filtered by name, largest first as a
   * simple "suggested" ordering.
   */
  async searchOtherForUser(
    excludeRoomIds: string[],
    q: string | undefined,
    limit: number
  ): Promise<GroupRoom[]> {
    return this.prisma.groupRoom.findMany({
      where: {
        ...(excludeRoomIds.length ? { roomId: { notIn: excludeRoomIds } } : {}),
        status: "ACTIVE",
        ...(q ? { AND: buildGroupSearchFilter(q) } : {}),
      },
      orderBy: { memberCount: "desc" },
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
