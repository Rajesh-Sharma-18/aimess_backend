import type { PrismaClient, RoomMember } from "../generated/prisma/index.js";

export class RoomMemberRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByRoomAndUser(
    roomId: string,
    userId: string
  ): Promise<RoomMember | null> {
    return this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
  }

  async upsert(
    roomId: string,
    userId: string,
    data: Record<string, unknown>
  ): Promise<RoomMember> {
    const joinedAt = (data.joinedAt as Date) ?? new Date();
    return this.prisma.roomMember.upsert({
      where: { roomId_userId: { roomId, userId } },
      create: {
        roomId,
        userId,
        status: (data.status as string) ?? "active",
        role: (data.role as string) ?? "member",
        joinedAt,
        // Seed the read pointer to the join time so a fresh member's derived
        // unread window starts at "now", not epoch 0. Without this, a null
        // lastReadAt makes countUnreadBulk treat EVERY community-wide message
        // ever sent (all pre-join history) as unread — a phantom badge the
        // moment you join. Only the CREATE branch sets it; updates (role change,
        // mute, ban, rejoin) never touch lastReadAt (data never carries it), so
        // a real read pointer is never clobbered.
        lastReadAt: (data.lastReadAt as Date) ?? joinedAt,
        leftAt: (data.leftAt as Date) ?? null,
        bannedAt: (data.bannedAt as Date) ?? null,
        banInfo: (data.banInfo as object) ?? null,
      },
      update: {
        ...data,
      } as Parameters<typeof this.prisma.roomMember.update>[0]["data"],
    });
  }

  /**
   * Mirror a moderation MUTE/UNMUTE from community-service onto the member row
   * (driven by the `community.member.mute_synced` event). `isMuted=false` also
   * clears `mutedUntil` so the local write-path gate lifts cleanly. Upsert so a
   * mute that races ahead of the membership sync still lands; the member row is
   * normally already present (mute only targets active members).
   */
  async setMute(
    roomId: string,
    userId: string,
    mute: { isMuted: boolean; mutedUntil: Date | null }
  ): Promise<RoomMember> {
    const mutedUntil = mute.isMuted ? mute.mutedUntil : null;
    return this.prisma.roomMember.upsert({
      where: { roomId_userId: { roomId, userId } },
      create: { roomId, userId, isMuted: mute.isMuted, mutedUntil },
      update: { isMuted: mute.isMuted, mutedUntil },
    });
  }

  async updateStatus(
    roomId: string,
    userId: string,
    status: string,
    extra?: Record<string, unknown>
  ): Promise<RoomMember | null> {
    return this.prisma.roomMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: { status, ...extra } as Parameters<
        typeof this.prisma.roomMember.update
      >[0]["data"],
    });
  }

  /**
   * Advance the member's read pointer to a specific message, forward-only: the
   * pointer is moved only when `messageCreatedAt` is newer than the stored
   * `lastReadAt` (never regresses). No-op if the member has no VISIBLE row.
   *
   * ACTIVE **and BANNED** rows both qualify. A ban is a read CUTOFF, not a
   * read-state freeze: the banned member still opens the community to re-read
   * the history they had before `bannedAt`, and that has to clear their unread
   * badge exactly like it does for anyone else — otherwise the badge is stuck
   * forever with no way to dismiss it. Nothing created after the ban is
   * readable (see {@link assertCommunityReadAccess}), so the pointer can only
   * ever advance to at most their cutoff. This is the single choke point for
   * that rule — every read-pointer write in community chat routes here.
   */
  async advanceReadPointer(
    roomId: string,
    userId: string,
    messageId: string,
    messageCreatedAt: Date,
    /**
     * Does this member currently give read receipts? Only then does the
     * EXPOSABLE pointer move — see GroupMemberRepository.advanceReadPointer.
     */
    givesReceipts = true
  ): Promise<RoomMember | null> {
    const existing = await this.prisma.roomMember.findFirst({
      where: { roomId, userId, status: { in: ["active", "banned"] } },
    });
    if (!existing) return null;

    // Forward-only: skip if the stored pointer is already at/after this message.
    if (existing.lastReadAt && existing.lastReadAt >= messageCreatedAt) {
      return existing;
    }

    return this.prisma.roomMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: {
        lastReadMessageId: messageId,
        lastReadAt: messageCreatedAt,
        receiptReadMessageId: givesReceipts
          ? messageId
          : (existing.receiptReadMessageId ?? existing.lastReadMessageId),
        receiptReadAt: givesReceipts
          ? new Date()
          : (existing.receiptReadAt ?? existing.lastReadAt ?? new Date(0)),
      },
    });
  }

  /**
   * Advance lastReadAt to `readAt` (default: now) for the user's VISIBLE rows
   * across many rooms. The caller may pass the boundary so the same instant can
   * be reused for the post-write unread recount and the read_sync payload.
   *
   * ACTIVE **and BANNED** rows both qualify, for the same reason as
   * {@link advanceReadPointer}: a banned community stays in the caller's list
   * carrying an unread badge, so "Mark all as read" has to be able to clear it
   * too — otherwise it is the one row in the list the action silently skips.
   */
  async bulkAdvanceReadToNow(
    userId: string,
    roomIds: string[],
    readAt: Date = new Date()
  ): Promise<number> {
    if (!roomIds.length) return 0;
    const result = await this.prisma.roomMember.updateMany({
      where: {
        userId,
        status: { in: ["active", "banned"] },
        roomId: { in: roomIds },
      },
      data: { lastReadAt: readAt },
    });
    return result.count;
  }

  /** Mark every active member of a room as left (community disbanded/deleted). */
  async markAllLeft(roomId: string): Promise<void> {
    await this.prisma.roomMember.updateMany({
      where: { roomId, status: "active" },
      data: { status: "left", leftAt: new Date() },
    });
  }

  /** userIds of every non-left member of a room — the mirror the reconciler diffs against community-service. */
  async findLiveMemberUserIds(roomId: string): Promise<string[]> {
    const rows = await this.prisma.roomMember.findMany({
      where: { roomId, status: { in: ["active", "banned"] } },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  /** Mark specific members of a room as left (their community membership is gone). */
  async markLeftForUsers(roomId: string, userIds: string[]): Promise<number> {
    if (!userIds.length) return 0;
    const result = await this.prisma.roomMember.updateMany({
      where: {
        roomId,
        userId: { in: userIds },
        status: { in: ["active", "banned"] },
      },
      data: { status: "left", leftAt: new Date() },
    });
    return result.count;
  }

  async isBanned(roomId: string, userId: string): Promise<boolean> {
    const member = await this.prisma.roomMember.findFirst({
      where: { roomId, userId, status: "banned" },
    });
    return member !== null;
  }

  async findActiveByRoom(roomId: string): Promise<RoomMember[]> {
    return this.prisma.roomMember.findMany({
      where: { roomId, status: "active" },
    });
  }

  /**
   * Every community room a user is an ACTIVE member of — unbounded (no
   * roomIds filter), for the Community nav badge total. Unlike
   * findVisibleByUserAndRooms this excludes "banned" rows: a banned member
   * shouldn't contribute to the badge even though they can still read up to
   * their cutoff.
   */
  async findActiveByUser(userId: string): Promise<RoomMember[]> {
    return this.prisma.roomMember.findMany({
      where: { userId, status: "active" },
    });
  }

  /**
   * Lightweight read-status projection (userId, lastReadAt, joinedAt) for
   * active members of a room. Kept for callers that still need per-member
   * cursor/joinedAt data; history serializers no longer use this to attach
   * per-message `readBy`/`deliveredTo` onto the wire.
   */
  async findReadStatusByRoom(
    roomId: string
  ): Promise<
    Array<{ userId: string; lastReadAt: Date | null; joinedAt: Date }>
  > {
    return this.prisma.roomMember.findMany({
      where: { roomId, status: "active" },
      select: { userId: true, lastReadAt: true, joinedAt: true },
    });
  }

  /**
   * ACTIVE members whose read pointer moved at/after `since` — the candidate
   * readers of a message created at `since`, for the per-message "Viewed by"
   * sheet. A pointer can only advance to `now`, so anyone who read this message
   * necessarily has `lastReadAt >= message.createdAt`; the caller still verifies
   * by sequenceNumber (a later read of an EARLIER message also passes this
   * filter). The point is to never load a 5 000-member roster to answer "who
   * read this" — banned/left members are excluded by the same status filter.
   *
   * Legacy rows with a null `lastReadAt` are skipped: no timestamp, no receipt.
   */
  async findActiveReadersSince(
    roomId: string,
    since: Date
  ): Promise<
    Array<{
      userId: string;
      lastReadMessageId: string | null;
      lastReadAt: Date | null;
      receiptReadMessageId: string | null;
      receiptReadAt: Date | null;
    }>
  > {
    // Still bounded by `lastReadAt`: the exposable pointer never runs AHEAD of
    // the plain one, so this stays a superset of the members who could have a
    // receipt here, and the caller narrows it with `receiptCursorOf`.
    const rows = await this.prisma.roomMember.findMany({
      where: { roomId, status: "active", lastReadAt: { gte: since } },
      select: {
        userId: true,
        lastReadMessageId: true,
        lastReadAt: true,
        receiptReadMessageId: true,
        receiptReadAt: true,
      },
    });
    // Mongo's Prisma range filters also match an explicit null (the same trap
    // the auto-delete sweeper hit with `lte`), so re-assert it in code.
    return rows.filter((r) => r.lastReadAt != null);
  }

  /**
   * Room ids the user holds a VISIBLE membership row in (ACTIVE or BANNED) — the
   * membership half of the community room list/search visibility rule. BANNED is
   * included on purpose: a banned member keeps the community in their list (they
   * just can't act in it), the same READ/WRITE split
   * {@link assertCommunityReadAccess} applies. Ids only, so a user in thousands
   * of communities still costs one projected query.
   */
  async findVisibleRoomIdsByUser(userId: string): Promise<string[]> {
    const rows = await this.prisma.roomMember.findMany({
      where: { userId, status: { in: ["active", "banned"] } },
      select: { roomId: true },
    });
    return rows.map((r) => r.roomId);
  }

  /**
   * Bulk: a user's ACTIVE + BANNED member rows across many rooms — the basis for
   * member-only community-chat summaries. BANNED rows are included (with
   * `bannedAt`) so the caller can clamp a banned member's summary to a read
   * CUTOFF instead of dropping it — same READ/WRITE split as
   * {@link assertCommunityReadAccess}'s `allowBannedReadCutoff`. One query, no N+1.
   */
  async findVisibleByUserAndRooms(
    userId: string,
    roomIds: string[]
  ): Promise<RoomMember[]> {
    if (!roomIds.length) return [];
    return this.prisma.roomMember.findMany({
      where: {
        userId,
        status: { in: ["active", "banned"] },
        roomId: { in: roomIds },
      },
    });
  }

  async attachSenderRoomStatus(
    roomId: string,
    messages: Array<Record<string, unknown>>
  ): Promise<Array<Record<string, unknown>>> {
    const senderIds = [
      ...new Set(messages.map((m) => String(m.sentBy || "")).filter(Boolean)),
    ];
    if (!senderIds.length) return messages;

    const members = await this.prisma.roomMember.findMany({
      where: {
        roomId,
        userId: { in: senderIds },
      },
      select: { userId: true, status: true, role: true },
    });

    const statusMap = new Map(members.map((m) => [m.userId, m]));

    return messages.map((msg) => {
      const memberInfo = statusMap.get(String(msg.sentBy || ""));
      return {
        ...msg,
        senderRoomStatus: memberInfo?.status || null,
        senderRoomRole: memberInfo?.role || null,
      };
    });
  }
}
