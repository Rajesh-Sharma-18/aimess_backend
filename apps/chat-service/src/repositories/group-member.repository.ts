import type { PrismaClient, GroupMember } from "../generated/prisma/index.js";
import { withWriteConflictRetry } from "../lib/db-errors.js";
import { isObjectId } from "../lib/object-id.js";

export class GroupMemberRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    roomId: string;
    userId: string;
    [key: string]: unknown;
  }): Promise<GroupMember> {
    return this.prisma.groupMember.create({
      data: {
        roomId: data.roomId,
        userId: data.userId,
        role: (data.role as string) ?? "MEMBER",
        status: (data.status as string) ?? "ACTIVE",
        joinedAt: (data.joinedAt as Date) ?? new Date(),
        invitedBy: (data.invitedBy as string) ?? null,
        leftAt: (data.leftAt as Date) ?? null,
        kickedAt: (data.kickedAt as Date) ?? null,
        kickedBy: (data.kickedBy as string) ?? null,
        kickReason: (data.kickReason as string) ?? null,
        bannedAt: (data.bannedAt as Date) ?? null,
        bannedBy: (data.bannedBy as string) ?? null,
        lastReadMessageId: (data.lastReadMessageId as string) ?? null,
        lastReadAt: (data.lastReadAt as Date) ?? null,
        unreadCount: (data.unreadCount as number) ?? 0,
        notificationSettings: (data.notificationSettings as object) ?? {
          mute: false,
          muteUntil: null,
        },
      },
    });
  }

  /**
   * Which of `userIds` have muted this group, in ONE query.
   *
   * Batched counterpart of the `checkGroupMute` gRPC method. The push fan-out
   * called that once per recipient, so a 256-member group message meant 256
   * gRPC round trips back into this service, each with its own `GroupMember`
   * read, while it was also serving sends.
   *
   * Mute semantics are identical to the single-row check, deliberately: muted
   * with no `muteUntil` is indefinite, a `muteUntil` in the future is still
   * muted, and one in the past has expired. Diverging here would silence
   * pushes the per-row check would have delivered.
   */
  async findMutedUserIds(roomId: string, userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return [];

    const rows = await this.prisma.groupMember.findMany({
      where: { roomId, userId: { in: userIds } },
      select: { userId: true, notificationSettings: true },
    });

    const now = Date.now();
    return rows
      .filter((row) => {
        const settings = (row.notificationSettings ?? {}) as {
          mute?: boolean;
          muteUntil?: string | null;
        };
        if (settings.mute !== true) return false;
        const muteUntilMs = settings.muteUntil
          ? new Date(settings.muteUntil).getTime()
          : null;
        return muteUntilMs == null || muteUntilMs > now;
      })
      .map((row) => row.userId);
  }

  async findByRoomAndUser(
    roomId: string,
    userId: string
  ): Promise<GroupMember | null> {
    return this.prisma.groupMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
  }

  async findActiveByRoomAndUser(
    roomId: string,
    userId: string
  ): Promise<GroupMember | null> {
    return this.prisma.groupMember.findFirst({
      where: { roomId, userId, status: "ACTIVE" },
    });
  }

  async findActiveMembers(
    roomId: string,
    params?: { limit?: number; cursor?: string | null }
  ): Promise<GroupMember[]> {
    return this.prisma.groupMember.findMany({
      where: {
        roomId,
        status: "ACTIVE",
        ...(params?.cursor
          ? { joinedAt: { gt: new Date(params.cursor) } }
          : {}),
      },
      orderBy: { joinedAt: "asc" },
      ...(params?.limit ? { take: params.limit } : {}),
    });
  }

  /** Rows flagged muted — callers still drop expired windows via isGroupMemberMuted. */
  async findMutedMembers(roomId: string): Promise<GroupMember[]> {
    return this.prisma.groupMember.findMany({
      where: { roomId, status: "ACTIVE", moderationMuted: true },
      orderBy: { joinedAt: "asc" },
    });
  }

  async getActiveRoomIds(userId: string): Promise<string[]> {
    const members = await this.prisma.groupMember.findMany({
      where: { userId, status: "ACTIVE" },
      select: { roomId: true },
    });
    return members.map((m) => m.roomId);
  }

  /**
   * Active memberships for a user with the per-room fields the inbox needs to
   * enrich each group item (unread count, mute state, role) without a second
   * round trip per room.
   */
  async getActiveMemberships(userId: string): Promise<
    Array<{
      roomId: string;
      role: string;
      unreadCount: number;
      notificationSettings: GroupMember["notificationSettings"];
      clearedAt: Date | null;
      clearChatAt: Date | null;
    }>
  > {
    return this.prisma.groupMember.findMany({
      where: { userId, status: "ACTIVE" },
      select: {
        roomId: true,
        role: true,
        unreadCount: true,
        notificationSettings: true,
        clearedAt: true,
        clearChatAt: true,
      },
    });
  }

  /**
   * Same as {@link getActiveMemberships} plus rooms the user voluntarily LEFT
   * or was KICKED (removed) from — feeds the inbox listing so an ex-member's
   * group stays visible (read-only, history intact) instead of vanishing,
   * WhatsApp-style. BANNED rows are still excluded: a ban keeps its existing
   * harder "gone" behavior.
   */
  async getActiveOrLeftMemberships(userId: string): Promise<
    Array<{
      roomId: string;
      role: string;
      unreadCount: number;
      notificationSettings: GroupMember["notificationSettings"];
      clearedAt: Date | null;
      clearChatAt: Date | null;
      status: string;
      leftAt: Date | null;
      kickedAt: Date | null;
      moderationMuted: boolean;
      moderationMutedUntil: Date | null;
      lastReadMessageId: string | null;
    }>
  > {
    return this.prisma.groupMember.findMany({
      where: { userId, status: { in: ["ACTIVE", "LEFT", "KICKED"] } },
      select: {
        roomId: true,
        role: true,
        unreadCount: true,
        // The caller's own read watermark — the anchor an unread divider opens on.
        lastReadMessageId: true,
        notificationSettings: true,
        clearedAt: true,
        clearChatAt: true,
        status: true,
        leftAt: true,
        kickedAt: true,
        // Moderation mute — surfaced on every inbox row so a client that was
        // offline when the mute landed restores the disabled composer on its
        // first list fetch, with no extra request.
        moderationMuted: true,
        moderationMutedUntil: true,
      },
    });
  }

  /**
   * "Delete Conversation" for a group: membership is untouched (unlike Leave)
   * but all history up to now is hidden — mirrors PrivateRoomRepository.setDeletedFor.
   * Also zeroes unread state so a phantom count doesn't survive the cutoff.
   * Status is not filtered here: a LEFT/KICKED member still has the read-only
   * row in their list and must be able to delete it. The caller
   * (GroupRoomService.clearConversation) owns the status check.
   */
  async setClearedAt(roomId: string, userId: string): Promise<void> {
    await this.prisma.groupMember.updateMany({
      where: { roomId, userId },
      data: {
        clearedAt: new Date(),
        unreadCount: 0,
        lastReadAt: new Date(),
      },
    });
  }

  async setClearChatAt(roomId: string, userId: string): Promise<void> {
    await this.prisma.groupMember.updateMany({
      where: { roomId, userId, status: "ACTIVE" },
      data: {
        clearChatAt: new Date(),
        unreadCount: 0,
        lastReadAt: new Date(),
      },
    });
  }

  async updateStatus(
    roomId: string,
    userId: string,
    status: string,
    extra?: Record<string, unknown>
  ): Promise<GroupMember | null> {
    return this.prisma.groupMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: { status, ...extra } as Parameters<
        typeof this.prisma.groupMember.update
      >[0]["data"],
    });
  }

  /**
   * End every ACTIVE membership in a room in one write — the membership half of
   * a disband. Rows become LEFT with `leftAt = at`, which is what every guard
   * already reads: `assertGroupMember` (ACTIVE-only) then denies all writes,
   * while `assertGroupReadAccess` keeps the group readable up to that instant,
   * so a disbanded group behaves like one you left — visible, read-only, dead.
   *
   * Returns how many memberships were ended (0 on a re-run — idempotent).
   */
  async markAllLeft(roomId: string, at: Date): Promise<number> {
    const result = await this.prisma.groupMember.updateMany({
      where: { roomId, status: "ACTIVE" },
      data: { status: "LEFT", leftAt: at },
    });
    return result.count;
  }

  async updateRole(
    roomId: string,
    userId: string,
    role: string
  ): Promise<GroupMember | null> {
    return this.prisma.groupMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: { role },
    });
  }

  /** Moderator-imposed mute (distinct from `setMuted`'s self-notification mute). */
  async setModerationMute(
    roomId: string,
    userId: string,
    params: { mutedBy: string; mutedUntil: Date | null }
  ): Promise<GroupMember | null> {
    return this.prisma.groupMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: {
        moderationMuted: true,
        moderationMutedUntil: params.mutedUntil,
        moderationMutedBy: params.mutedBy,
      },
    });
  }

  async clearModerationMute(
    roomId: string,
    userId: string
  ): Promise<GroupMember | null> {
    return this.prisma.groupMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: {
        moderationMuted: false,
        moderationMutedUntil: null,
        moderationMutedBy: null,
      },
    });
  }

  /**
   * TIMED moderation mutes whose `moderationMutedUntil` has already passed —
   * feeds the auto-unmute sweep. Indefinite mutes (`moderationMutedUntil: null`)
   * are never returned. Mirrors community's `findExpiredMemberMutes`.
   */
  async findExpiredModerationMutes(params: {
    now: Date;
    limit: number;
  }): Promise<Array<{ id: string; roomId: string; userId: string }>> {
    return this.prisma.groupMember.findMany({
      where: {
        moderationMuted: true,
        moderationMutedUntil: { not: null, lte: params.now },
      },
      select: { id: true, roomId: true, userId: true },
      take: params.limit,
    });
  }

  /**
   * ATOMIC claim of one expired mute: clears the mute only while it is still
   * expired-and-set, so exactly ONE sweeper instance (or RabbitMQ redelivery)
   * runs the unmute side-effects. Returns the number of rows changed — 1 means
   * this caller owns the expiry, 0 means someone else already handled it.
   * Mirrors community's `claimExpiredMemberMute`.
   */
  async claimExpiredModerationMute(id: string, now: Date): Promise<number> {
    const { count } = await this.prisma.groupMember.updateMany({
      where: {
        id,
        moderationMuted: true,
        moderationMutedUntil: { not: null, lte: now },
      },
      data: {
        moderationMuted: false,
        moderationMutedUntil: null,
        moderationMutedBy: null,
      },
    });
    return count;
  }

  /**
   * Personal (per-member) notification mute — mirrors PrivateRoomRepository's
   * setMuted/setUnmuted, but stored on the GroupMember row itself since group
   * mute is per-membership, not per-room. `notificationSettings.mute`/
   * `muteUntil` were already read by GroupRoomService.getInboxGroups; this was
   * the missing write path.
   */
  async setMuted(
    roomId: string,
    userId: string,
    muteUntil: Date | null
  ): Promise<GroupMember | null> {
    const existing = await this.prisma.groupMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!existing) return null;
    return this.prisma.groupMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: {
        notificationSettings: {
          mute: true,
          muteUntil: muteUntil ? muteUntil.toISOString() : null,
        },
      },
    });
  }

  async setUnmuted(
    roomId: string,
    userId: string
  ): Promise<GroupMember | null> {
    const existing = await this.prisma.groupMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!existing) return null;
    return this.prisma.groupMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: { notificationSettings: { mute: false, muteUntil: null } },
    });
  }

  /**
   * Advance the member's read pointer to a specific message, forward-only: the
   * pointer is moved only when `messageCreatedAt` is newer than the stored
   * `lastReadAt` (never regresses). No-op if the member isn't ACTIVE.
   *
   * `remainingUnread` is the count of messages still newer than the NEW pointer
   * that are visible to this user (computed by the caller). We set `unreadCount`
   * to that instead of hard-zeroing, so viewing an OLD page (whose newest message
   * still post-dates messages the user hasn't seen) doesn't wrongly clear unread.
   */
  async advanceReadPointer(
    roomId: string,
    userId: string,
    messageId: string,
    messageCreatedAt: Date,
    remainingUnread: number,
    /**
     * Does this member currently give read receipts? Only then does the
     * EXPOSABLE pointer (`receiptRead*`) move with the read one; off, it freezes
     * where it stood so the read never surfaces — not live, and not on a later
     * refresh once the switch goes back on.
     */
    givesReceipts = true
  ): Promise<GroupMember | null> {
    // Guard against optimistic client ids ("tmp-…") — Prisma throws on a
    // non-ObjectId write into `lastReadMessageId` (@db.ObjectId).
    if (!isObjectId(messageId)) return null;

    const existing = await this.prisma.groupMember.findFirst({
      where: { roomId, userId, status: "ACTIVE" },
    });
    if (!existing) return null;

    // Forward-only: skip if the stored pointer is already at/after this message.
    // `lastReadAt` has millisecond resolution and a rapid burst can put two
    // messages on the SAME timestamp (see PrivateRoom.lastMessageSeq), so a tie
    // only refuses when it is literally the same message — otherwise the second
    // of such a pair could never be marked read and the member's badge stuck.
    if (
      existing.lastReadAt &&
      (existing.lastReadAt > messageCreatedAt ||
        (existing.lastReadAt.getTime() === messageCreatedAt.getTime() &&
          existing.lastReadMessageId === messageId))
    ) {
      return existing;
    }

    return this.prisma.groupMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: {
        lastReadMessageId: messageId,
        lastReadAt: messageCreatedAt,
        unreadCount: remainingUnread < 0 ? 0 : remainingUnread,
        // Written on EVERY accepted read so the legacy fallback in
        // `receiptCursorOf` stops after the first one: giving receipts advances
        // it, not giving them pins it to what this member had already published.
        receiptReadMessageId: givesReceipts
          ? messageId
          : (existing.receiptReadMessageId ?? existing.lastReadMessageId),
        // The instant of the RECEIPT — `lastReadAt` above stores the MESSAGE's
        // own createdAt, which says nothing about when the switch was on. Frozen with
        // nothing to freeze — a member whose FIRST read comes with the switch
        // off — still has to write something, or the row stays indistinguishable
        // from one that predates these columns and `receiptCursorOf` would fall
        // back to the plain pointer and leak exactly the read being withheld.
        // Epoch is that marker: no id, so it is nobody's receipt.
        receiptReadAt: givesReceipts
          ? new Date()
          : (existing.receiptReadAt ?? existing.lastReadAt ?? new Date(0)),
      },
    });
  }

  async incUnreadForRoom(
    roomId: string,
    excludeUserId: string,
    increment = 1
  ): Promise<void> {
    if (increment <= 0) return;
    // Same write-conflict-retry as GroupRoomRepository.updateLastMessage — this
    // `$inc updateMany` and that room bump land moments apart for every send;
    // without the retry, a transient P2034 here (and only here) desyncs the
    // inbox's unread badge from its already-bumped lastActivity/preview.
    await withWriteConflictRetry(() =>
      this.prisma.groupMember.updateMany({
        where: {
          roomId,
          status: "ACTIVE",
          userId: { not: excludeUserId },
        },
        data: { unreadCount: { increment } },
      })
    );
  }

  async decrementUnreadForMessage(params: {
    roomId: string;
    senderId: string | null;
    messageCreatedAt: Date;
    /**
     * Delete-for-ME: restrict the decrement to this one member. Omitted by
     * delete-for-everyone, which correctly adjusts every member who still had
     * the message in their unread window.
     */
    onlyUserId?: string;
  }): Promise<void> {
    await this.prisma.groupMember.updateMany({
      where: {
        roomId: params.roomId,
        status: "ACTIVE",
        // Never lets a badge go negative, and makes a double-delivered decrement
        // harmless.
        unreadCount: { gt: 0 },
        ...(params.onlyUserId
          ? { userId: params.onlyUserId }
          : params.senderId
            ? { userId: { not: params.senderId } }
            : {}),
        OR: [
          { lastReadAt: null },
          { lastReadAt: { lt: params.messageCreatedAt } },
        ],
      },
      data: { unreadCount: { decrement: 1 } },
    });
  }

  /**
   * How many ACTIVE members hold `role` — used to answer "does this group still
   * have an owner?" before letting anyone join it. Served by the existing
   * `[roomId, status, role]` index, so it is one cheap count, not a scan.
   */
  async countActiveByRole(roomId: string, role: string): Promise<number> {
    return this.prisma.groupMember.count({
      where: { roomId, status: "ACTIVE", role },
    });
  }

  async countActiveMembers(roomId: string): Promise<number> {
    return this.prisma.groupMember.count({
      where: { roomId, status: "ACTIVE" },
    });
  }

  /**
   * Live roster size for the admin group detail — ACTIVE + BANNED, matching
   * exactly what {@link adminListMembers} shows by default. The denormalized
   * GroupRoom.memberCount drifts (a LEFT/KICKED owner is still counted), so the
   * detail header must count the real rows instead of trusting that field.
   */
  async countRosterMembers(roomId: string): Promise<number> {
    return this.prisma.groupMember.count({
      where: { roomId, status: { in: ["ACTIVE", "BANNED"] } },
    });
  }

  /**
   * Batched {@link countRosterMembers} for the admin group list — one grouped
   * query for a page of rooms. Rooms with no ACTIVE/BANNED rows are absent from
   * the map (caller defaults to 0).
   */
  async countRosterMembersForRooms(
    roomIds: string[]
  ): Promise<Map<string, number>> {
    const ids = [...new Set(roomIds.filter(Boolean))];
    if (!ids.length) return new Map();
    const grouped = await this.prisma.groupMember.groupBy({
      by: ["roomId"],
      where: { roomId: { in: ids }, status: { in: ["ACTIVE", "BANNED"] } },
      _count: { _all: true },
    });
    return new Map(grouped.map((g) => [g.roomId, g._count._all]));
  }

  /**
   * Admin Group Management: map each given roomId → its ACTIVE owner userId.
   * Rooms without an ADMIN row are simply absent (callers fall back to
   * GroupRoom.createdBy).
   */
  async findOwnersForRooms(roomIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const ids = [...new Set(roomIds.filter(Boolean))];
    if (!ids.length) return map;
    const owners = await this.prisma.groupMember.findMany({
      where: { role: "ADMIN", status: "ACTIVE", roomId: { in: ids } },
      select: { roomId: true, userId: true },
    });
    for (const o of owners) {
      if (!map.has(o.roomId)) map.set(o.roomId, o.userId);
    }
    return map;
  }

  /**
   * Admin Group Management: roomIds OWNED by any of the given userIds. Used to
   * widen the group-list `q` search to owner identity matches.
   */
  async findRoomIdsByOwnerUserIds(userIds: string[]): Promise<string[]> {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length) return [];
    const rows = await this.prisma.groupMember.findMany({
      where: { role: "ADMIN", userId: { in: ids } },
      select: { roomId: true },
    });
    return [...new Set(rows.map((r) => r.roomId))];
  }

  /**
   * Admin Group Management: filterable/paginated members of one room.
   * `status` is "" / "ACTIVE" (default, active only), "ALL" (no filter) or an
   * exact membership status — moderation state (LEFT/KICKED/BANNED) is
   * otherwise invisible to the admin panel. `userIdsFromSearch` (free-text
   * identity matches) and `qExactUserId` (a UUID pasted verbatim) both constrain
   * to a userId set when present.
   */
  async adminListMembers(params: {
    roomId: string;
    role?: string;
    status?: string;
    userIdsFromSearch?: string[] | null;
    qExactUserId?: string | null;
    skip: number;
    take: number;
  }): Promise<{ rows: GroupMember[]; total: number }> {
    const {
      roomId,
      role,
      status,
      userIdsFromSearch,
      qExactUserId,
      skip,
      take,
    } = params;

    const and: Array<Record<string, unknown>> = [{ roomId }];
    // Default (no explicit status) shows the meaningful roster — ACTIVE members
    // PLUS BANNED ones (so a group-banned member, incl. a banned owner of a
    // CLOSED group, stays visible and can be unbanned). LEFT/KICKED are still
    // excluded. "ALL" drops the filter entirely; any explicit status is exact.
    const statusFilter = (status || "").toUpperCase();
    if (statusFilter === "") {
      and.push({ status: { in: ["ACTIVE", "BANNED"] } });
    } else if (statusFilter !== "ALL") {
      and.push({ status: statusFilter });
    }
    if (role) and.push({ role });
    if (userIdsFromSearch || qExactUserId) {
      const dedup = [
        ...new Set([
          ...(userIdsFromSearch ?? []),
          ...(qExactUserId ? [qExactUserId] : []),
        ]),
      ];
      and.push({ userId: { in: dedup } });
    }

    type FindArgs = Parameters<typeof this.prisma.groupMember.findMany>[0];
    type WhereArg = NonNullable<FindArgs>["where"];
    const where = { AND: and } as WhereArg;

    const [rows, total] = await Promise.all([
      this.prisma.groupMember.findMany({
        where,
        orderBy: { joinedAt: "asc" },
        skip,
        take,
      }),
      this.prisma.groupMember.count({ where }),
    ]);

    return { rows, total };
  }

  async upsert(
    roomId: string,
    userId: string,
    data: Record<string, unknown>
  ): Promise<GroupMember> {
    return this.prisma.groupMember.upsert({
      where: { roomId_userId: { roomId, userId } },
      create: {
        roomId,
        userId,
        role: (data.role as string) ?? "MEMBER",
        status: (data.status as string) ?? "ACTIVE",
        joinedAt: (data.joinedAt as Date) ?? new Date(),
        invitedBy: (data.invitedBy as string) ?? null,
        unreadCount: (data.unreadCount as number) ?? 0,
        notificationSettings: (data.notificationSettings as object) ?? {
          mute: false,
          muteUntil: null,
        },
      },
      update: {
        ...data,
      } as Parameters<typeof this.prisma.groupMember.update>[0]["data"],
    });
  }
}
