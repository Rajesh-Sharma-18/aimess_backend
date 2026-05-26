import { prisma } from "../config/prisma.js";
import {
  CommunityInviteStatus,
  CommunityJoinReqStatus,
  CommunityMemberRole,
  CommunityMemberStatus,
  CommunityReportStatus,
  CommunityType,
  type Prisma,
} from "../generated/prisma/index.js";
import type { CommunityAuditAction } from "../types/community.types.js";

export const communityRepository = {
  // ---------------------------------------------------------------------------
  // Categories
  // ---------------------------------------------------------------------------
  listActiveCategories() {
    return prisma.communityCategory.findMany({
      where: { active: true },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      select: { id: true, name: true, slug: true },
    });
  },

  findActiveCategoryById(categoryId: string) {
    return prisma.communityCategory.findFirst({
      where: { id: categoryId, active: true },
      select: { id: true, name: true },
    });
  },

  // ---------------------------------------------------------------------------
  // Communities
  // ---------------------------------------------------------------------------
  // "Active" = deletedAt NOT set. Prisma omits unset optional fields on Mongo,
  // and `{ deletedAt: null }` does NOT match a missing field — so we filter on
  // `isSet: false`. Soft-delete sets a Date (never an explicit null).
  findById(id: string) {
    return prisma.community.findFirst({
      where: { id, deletedAt: { isSet: false } },
      include: { category: { select: { id: true, name: true } } },
    });
  },

  /** Case-insensitive display-name lookup (uniqueness check). */
  findByName(name: string) {
    return prisma.community.findFirst({
      where: {
        deletedAt: { isSet: false },
        name: { equals: name, mode: "insensitive" },
      },
      select: { id: true },
    });
  },

  /** Case-insensitive handle lookup (uniqueness check). */
  findByHandle(handle: string) {
    return prisma.community.findFirst({
      where: {
        deletedAt: { isSet: false },
        handle: { equals: handle, mode: "insensitive" },
      },
      select: { id: true },
    });
  },

  createCommunity(data: {
    name: string;
    handle: string;
    description: string | null;
    type: CommunityType;
    categoryId: string;
    creatorId: string;
    adminId: string;
    avatarUrl: string | null;
    coverUrl: string | null;
  }) {
    return prisma.community.create({
      data: {
        ...data,
        memberCount: 1,
      },
      include: { category: { select: { id: true, name: true } } },
    });
  },

  updateCommunity(id: string, data: Prisma.CommunityUpdateInput) {
    return prisma.community.update({
      where: { id },
      data,
      include: { category: { select: { id: true, name: true } } },
    });
  },

  setMemberCount(id: string, memberCount: number) {
    return prisma.community.update({
      where: { id },
      data: { memberCount },
    });
  },

  /** Transfer community ownership by setting a new adminId (auto-handover). */
  setCommunityAdmin(id: string, adminId: string) {
    return prisma.community.update({
      where: { id },
      data: { adminId },
    });
  },

  deleteCommunityHard(id: string) {
    return prisma.community.delete({ where: { id } });
  },

  // ---------------------------------------------------------------------------
  // Members
  // ---------------------------------------------------------------------------
  createMember(data: {
    communityId: string;
    userId: string;
    role: CommunityMemberRole;
    status: CommunityMemberStatus;
    snapshotUsername: string;
    snapshotDisplayName: string;
    snapshotAvatarKey: string | null;
  }) {
    return prisma.communityMember.create({ data });
  },

  /** Bulk insert members (single-collection — safe without a replica set). */
  createManyMembers(
    communityId: string,
    members: Array<{
      userId: string;
      role: CommunityMemberRole;
      status: CommunityMemberStatus;
      snapshotUsername: string;
      snapshotDisplayName: string;
      snapshotAvatarKey: string | null;
    }>
  ) {
    return prisma.communityMember.createMany({
      data: members.map((m) => ({ communityId, ...m })),
    });
  },

  deleteMembersForCommunity(communityId: string) {
    return prisma.communityMember.deleteMany({ where: { communityId } });
  },

  countActiveMembers(communityId: string) {
    return prisma.communityMember.count({
      where: { communityId, status: CommunityMemberStatus.ACTIVE },
    });
  },

  findMembership(communityId: string, userId: string) {
    return prisma.communityMember.findFirst({
      where: { communityId, userId },
      select: { role: true, status: true },
    });
  },

  /**
   * The longest-tenured ACTIVE moderator (earliest joinedAt) — used to pick the
   * auto-handover successor when an admin leaves. Returns just the userId.
   */
  findOldestActiveModerator(communityId: string) {
    return prisma.communityMember.findFirst({
      where: {
        communityId,
        role: CommunityMemberRole.MODERATOR,
        status: CommunityMemberStatus.ACTIVE,
      },
      orderBy: { joinedAt: "asc" },
      select: { userId: true },
    });
  },

  /**
   * The longest-tenured ACTIVE plain MEMBER (earliest joinedAt), excluding the
   * given user — fallback auto-handover successor when no MODERATOR exists.
   * Returns just the userId.
   */
  findOldestActiveMember(communityId: string, excludeUserId: string) {
    return prisma.communityMember.findFirst({
      where: {
        communityId,
        role: CommunityMemberRole.MEMBER,
        status: CommunityMemberStatus.ACTIVE,
        userId: { not: excludeUserId },
      },
      orderBy: { joinedAt: "asc" },
      select: { userId: true },
    });
  },

  /**
   * Bulk-mark every ACTIVE member of a community as LEFT — used by community
   * soft-delete to evict the roster in a single write. Returns the Prisma
   * batch payload (count of rows updated).
   */
  markAllActiveMembersLeft(communityId: string) {
    return prisma.communityMember.updateMany({
      where: { communityId, status: CommunityMemberStatus.ACTIVE },
      data: { status: CommunityMemberStatus.LEFT },
    });
  },

  /** Like `findMembership` but also returns the row id, userId, and joinedAt. */
  findMemberByUserId(communityId: string, userId: string) {
    return prisma.communityMember.findFirst({
      where: { communityId, userId },
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        joinedAt: true,
        snapshotUsername: true,
        snapshotDisplayName: true,
        snapshotAvatarKey: true,
      },
    });
  },

  /**
   * Existing membership rows for a set of userIds — used both to partition an
   * add-members request (skip ACTIVE/BANNED, reactivate LEFT, create missing)
   * and to build the API DTO for reactivated members from the in-hand row.
   * Selects `joinedAt` so reactivated members need no post-write re-read.
   * Index-supported by the (communityId, status) compound index.
   */
  findMembersByUserIds(communityId: string, userIds: string[]) {
    return prisma.communityMember.findMany({
      where: { communityId, userId: { in: userIds } },
      select: {
        userId: true,
        role: true,
        status: true,
        joinedAt: true,
        snapshotUsername: true,
        snapshotDisplayName: true,
        snapshotAvatarKey: true,
      },
    });
  },

  reactivateMemberWithSnapshot(
    communityId: string,
    userId: string,
    snapshot: {
      snapshotUsername: string;
      snapshotDisplayName: string;
      snapshotAvatarKey: string | null;
    }
  ) {
    return prisma.communityMember.update({
      where: { communityId_userId: { communityId, userId } },
      data: {
        status: CommunityMemberStatus.ACTIVE,
        role: CommunityMemberRole.MEMBER,
        ...snapshot,
      },
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        joinedAt: true,
        snapshotUsername: true,
        snapshotDisplayName: true,
        snapshotAvatarKey: true,
      },
    });
  },

  updateMemberSnapshotsByUserId(
    userId: string,
    snapshot: {
      snapshotUsername: string;
      snapshotDisplayName: string;
      snapshotAvatarKey: string | null;
    }
  ) {
    return prisma.communityMember.updateMany({
      where: { userId },
      data: snapshot,
    });
  },

  /** Single-document role update keyed by the (communityId, userId) unique. */
  updateMemberRole(
    communityId: string,
    userId: string,
    role: CommunityMemberRole
  ) {
    return prisma.communityMember.update({
      where: { communityId_userId: { communityId, userId } },
      data: { role },
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        joinedAt: true,
        snapshotUsername: true,
        snapshotDisplayName: true,
        snapshotAvatarKey: true,
      },
    });
  },

  /** Single-document status update keyed by the (communityId, userId) unique. */
  updateMemberStatus(
    communityId: string,
    userId: string,
    status: CommunityMemberStatus
  ) {
    return prisma.communityMember.update({
      where: { communityId_userId: { communityId, userId } },
      data: { status },
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        joinedAt: true,
        snapshotUsername: true,
        snapshotDisplayName: true,
        snapshotAvatarKey: true,
      },
    });
  },

  /**
   * Members of a community filtered by status — offset/page pagination on id.
   * Returns the page rows plus the total matching count.
   */
  async listMembers(params: {
    communityId: string;
    status: CommunityMemberStatus;
    page: number;
    limit: number;
  }) {
    const where = {
      communityId: params.communityId,
      status: params.status,
    };

    const [rows, total] = await Promise.all([
      prisma.communityMember.findMany({
        where,
        orderBy: { id: "asc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
        select: {
          id: true,
          userId: true,
          role: true,
          status: true,
          joinedAt: true,
          snapshotUsername: true,
          snapshotDisplayName: true,
          snapshotAvatarKey: true,
        },
      }),
      prisma.communityMember.count({ where }),
    ]);

    return { rows, total };
  },

  /**
   * Communities where the caller is an ACTIVE member — offset/page pagination
   * on id. Returns the page rows plus the total matching count.
   */
  async listMyMemberships(params: {
    userId: string;
    page: number;
    limit: number;
  }) {
    const where = {
      userId: params.userId,
      status: CommunityMemberStatus.ACTIVE,
      community: { deletedAt: { isSet: false } },
    };

    const [rows, total] = await Promise.all([
      prisma.communityMember.findMany({
        where,
        orderBy: { id: "asc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
        select: {
          id: true,
          role: true,
          community: {
            select: {
              id: true,
              name: true,
              handle: true,
              type: true,
              memberCount: true,
              avatarUrl: true,
            },
          },
        },
      }),
      prisma.communityMember.count({ where }),
    ]);

    return { rows, total };
  },

  // ---------------------------------------------------------------------------
  // Discovery / browse
  // ---------------------------------------------------------------------------
  /**
   * Community ids the user already has a relationship with (active, pending, or
   * banned) — excluded from discovery so users only see communities they can
   * still join. A user who LEFT keeps no row here, so left communities reappear.
   * The (userId, status) index backs this.
   */
  async listExcludedCommunityIds(userId: string): Promise<string[]> {
    const rows = await prisma.communityMember.findMany({
      where: {
        userId,
        status: {
          in: [
            CommunityMemberStatus.ACTIVE,
            CommunityMemberStatus.PENDING,
            CommunityMemberStatus.BANNED,
          ],
        },
      },
      select: { communityId: true },
    });
    return rows.map((r) => r.communityId);
  },

  /**
   * Public, non-deleted communities for discovery/browse, optionally filtered by
   * a name/handle search term and/or category, excluding the given community ids.
   * Newest-first (ObjectId is time-ordered) with offset/page pagination on `id`.
   * Returns the page rows plus the total matching count.
   */
  async listDiscoverable(params: {
    q?: string;
    categoryId?: string;
    excludeCommunityIds: string[];
    page: number;
    limit: number;
  }) {
    const where: Prisma.CommunityWhereInput = {
      deletedAt: { isSet: false },
      type: CommunityType.PUBLIC,
    };

    if (params.excludeCommunityIds.length > 0) {
      where.id = { notIn: params.excludeCommunityIds };
    }
    if (params.categoryId) {
      where.categoryId = params.categoryId;
    }
    if (params.q) {
      where.OR = [
        { name: { contains: params.q, mode: "insensitive" } },
        { handle: { contains: params.q, mode: "insensitive" } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.community.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
        select: {
          id: true,
          name: true,
          handle: true,
          description: true,
          type: true,
          memberCount: true,
          avatarUrl: true,
          createdAt: true,
          category: { select: { id: true, name: true } },
        },
      }),
      prisma.community.count({ where }),
    ]);

    return { rows, total };
  },

  // ---------------------------------------------------------------------------
  // Audit log (append-only moderation trail)
  // ---------------------------------------------------------------------------
  /** Append a single moderation audit entry. */
  createAuditLog(entry: {
    communityId: string;
    actorId: string;
    action: CommunityAuditAction;
    targetUserId?: string;
    reason?: string;
    metadata?: Prisma.InputJsonValue;
  }) {
    return prisma.communityAuditLog.create({ data: entry });
  },

  /**
   * Audit entries for a community, newest first. ObjectId is time-ordered, so
   * ordering on `id` desc matches createdAt order. Offset/page pagination on id;
   * returns the page rows plus the total matching count.
   */
  async listAuditLogs(params: {
    communityId: string;
    page: number;
    limit: number;
  }) {
    const where = { communityId: params.communityId };

    const [rows, total] = await Promise.all([
      prisma.communityAuditLog.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
        select: {
          id: true,
          communityId: true,
          actorId: true,
          action: true,
          targetUserId: true,
          reason: true,
          metadata: true,
          createdAt: true,
        },
      }),
      prisma.communityAuditLog.count({ where }),
    ]);

    return { rows, total };
  },

  // ---------------------------------------------------------------------------
  // Join requests
  // ---------------------------------------------------------------------------
  createJoinRequest(data: {
    communityId: string;
    userId: string;
    message: string | null;
  }) {
    return prisma.communityJoinRequest.create({
      data: {
        communityId: data.communityId,
        userId: data.userId,
        message: data.message,
        status: CommunityJoinReqStatus.PENDING,
      },
    });
  },

  findJoinRequestById(requestId: string) {
    return prisma.communityJoinRequest.findUnique({
      where: { id: requestId },
    });
  },

  findJoinRequestByCommunityAndUser(communityId: string, userId: string) {
    return prisma.communityJoinRequest.findUnique({
      where: { communityId_userId: { communityId, userId } },
    });
  },

  updateJoinRequest(
    requestId: string,
    data: {
      status?: CommunityJoinReqStatus;
      message?: string | null;
      decidedBy?: string | null;
      decidedAt?: Date | null;
    }
  ) {
    return prisma.communityJoinRequest.update({
      where: { id: requestId },
      data,
    });
  },

  /**
   * Recycle a non-PENDING request row back to PENDING. Clears decidedBy/decidedAt
   * (re-uses the (communityId, userId) unique row instead of inserting a dup).
   */
  recyclePendingJoinRequest(requestId: string, message: string | null) {
    return prisma.communityJoinRequest.update({
      where: { id: requestId },
      data: {
        status: CommunityJoinReqStatus.PENDING,
        decidedBy: null,
        decidedAt: null,
        message,
      },
    });
  },

  async listCommunityJoinRequests(params: {
    communityId: string;
    status?: CommunityJoinReqStatus;
    page: number;
    limit: number;
  }) {
    const where: Prisma.CommunityJoinRequestWhereInput = {
      communityId: params.communityId,
    };
    if (params.status) where.status = params.status;

    const [rows, total] = await Promise.all([
      prisma.communityJoinRequest.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.communityJoinRequest.count({ where }),
    ]);

    return { rows, total };
  },

  async listMyJoinRequests(params: {
    userId: string;
    status?: CommunityJoinReqStatus;
    page: number;
    limit: number;
  }) {
    const where: Prisma.CommunityJoinRequestWhereInput = {
      userId: params.userId,
    };
    if (params.status) where.status = params.status;

    const [rows, total] = await Promise.all([
      prisma.communityJoinRequest.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.communityJoinRequest.count({ where }),
    ]);

    return { rows, total };
  },

  // ---------------------------------------------------------------------------
  // Invites
  // ---------------------------------------------------------------------------
  createInvite(data: {
    communityId: string;
    inviterId: string;
    inviteeId: string;
  }) {
    return prisma.communityInvite.create({
      data: {
        communityId: data.communityId,
        inviterId: data.inviterId,
        inviteeId: data.inviteeId,
        status: CommunityInviteStatus.PENDING,
      },
    });
  },

  findInviteById(inviteId: string) {
    return prisma.communityInvite.findUnique({
      where: { id: inviteId },
    });
  },

  findInviteByCommunityAndInvitee(communityId: string, inviteeId: string) {
    return prisma.communityInvite.findUnique({
      where: { communityId_inviteeId: { communityId, inviteeId } },
    });
  },

  updateInvite(
    inviteId: string,
    data: { status?: CommunityInviteStatus; inviterId?: string }
  ) {
    return prisma.communityInvite.update({
      where: { id: inviteId },
      data,
    });
  },

  /** Recycle a non-PENDING invite back to PENDING with a new inviter. */
  recyclePendingInvite(inviteId: string, inviterId: string) {
    return prisma.communityInvite.update({
      where: { id: inviteId },
      data: {
        status: CommunityInviteStatus.PENDING,
        inviterId,
      },
    });
  },

  async listCommunityInvites(params: {
    communityId: string;
    status?: CommunityInviteStatus;
    page: number;
    limit: number;
  }) {
    const where: Prisma.CommunityInviteWhereInput = {
      communityId: params.communityId,
    };
    if (params.status) where.status = params.status;

    const [rows, total] = await Promise.all([
      prisma.communityInvite.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.communityInvite.count({ where }),
    ]);

    return { rows, total };
  },

  async listMyInvites(params: {
    inviteeId: string;
    status?: CommunityInviteStatus;
    page: number;
    limit: number;
  }) {
    const where: Prisma.CommunityInviteWhereInput = {
      inviteeId: params.inviteeId,
    };
    if (params.status) where.status = params.status;

    const [rows, total] = await Promise.all([
      prisma.communityInvite.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.communityInvite.count({ where }),
    ]);

    return { rows, total };
  },

  /**
   * Batch fetch community summaries by id — used by list-my-invites and
   * list-my-join-requests to avoid N+1 lookups. Filters out soft-deleted rows.
   * Returned ordering is NOT guaranteed; callers must build a Map by id.
   */
  findCommunitiesByIds(ids: string[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return prisma.community.findMany({
      where: { id: { in: ids }, deletedAt: { isSet: false } },
      select: {
        id: true,
        name: true,
        handle: true,
        type: true,
        memberCount: true,
        avatarUrl: true,
      },
    });
  },

  // ---------------------------------------------------------------------------
  // Reports
  // ---------------------------------------------------------------------------
  createReport(data: {
    communityId: string;
    reporterId: string;
    targetUserId: string | null;
    reason: string;
  }) {
    return prisma.communityReport.create({
      data: {
        communityId: data.communityId,
        reporterId: data.reporterId,
        targetUserId: data.targetUserId,
        reason: data.reason,
        status: CommunityReportStatus.OPEN,
      },
    });
  },

  findReportById(reportId: string) {
    return prisma.communityReport.findUnique({
      where: { id: reportId },
    });
  },

  /**
   * Idempotent-dedup helper: find an existing OPEN report from the same
   * reporter on the same (communityId, targetUserId) tuple. `targetUserId`
   * MUST be passed explicitly (null for community-level reports) — Mongo
   * stores the field as null when omitted, so we match on the precise value.
   */
  findOpenReportByReporterAndTarget(params: {
    communityId: string;
    reporterId: string;
    targetUserId: string | null;
  }) {
    return prisma.communityReport.findFirst({
      where: {
        communityId: params.communityId,
        reporterId: params.reporterId,
        targetUserId: params.targetUserId,
        status: CommunityReportStatus.OPEN,
      },
    });
  },

  updateReport(
    reportId: string,
    data: {
      status?: CommunityReportStatus;
      reviewedBy?: string | null;
      reviewedAt?: Date | null;
      resolution?: string | null;
    }
  ) {
    return prisma.communityReport.update({
      where: { id: reportId },
      data,
    });
  },

  async listCommunityReports(params: {
    communityId: string;
    status?: CommunityReportStatus;
    page: number;
    limit: number;
  }) {
    const where: Prisma.CommunityReportWhereInput = {
      communityId: params.communityId,
    };
    if (params.status) where.status = params.status;

    const [rows, total] = await Promise.all([
      prisma.communityReport.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.communityReport.count({ where }),
    ]);
    return { rows, total };
  },

  async listMyReports(params: {
    reporterId: string;
    status?: CommunityReportStatus;
    page: number;
    limit: number;
  }) {
    const where: Prisma.CommunityReportWhereInput = {
      reporterId: params.reporterId,
    };
    if (params.status) where.status = params.status;

    const [rows, total] = await Promise.all([
      prisma.communityReport.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.communityReport.count({ where }),
    ]);
    return { rows, total };
  },

  // ---------------------------------------------------------------------------
  // Mute settings
  // ---------------------------------------------------------------------------
  findMuteByUserAndCommunity(userId: string, communityId: string) {
    return prisma.communityMuteSetting.findUnique({
      where: { userId_communityId: { userId, communityId } },
    });
  },

  /**
   * Built for the future notifications-service fan-out — list all mute rows
   * the user has for a given set of communities. Free to ship now.
   */
  findMutesByUserAndCommunityIds(userId: string, communityIds: string[]) {
    return prisma.communityMuteSetting.findMany({
      where: { userId, communityId: { in: communityIds } },
    });
  },

  upsertMute(userId: string, communityId: string, mutedUntil: Date | null) {
    return prisma.communityMuteSetting.upsert({
      where: { userId_communityId: { userId, communityId } },
      create: { userId, communityId, mutedUntil },
      update: { mutedUntil },
    });
  },

  clearMute(userId: string, communityId: string) {
    return prisma.communityMuteSetting.deleteMany({
      where: { userId, communityId },
    });
  },

  // ---------------------------------------------------------------------------
  // Invite links (shareable join links — distinct from 1:1 invites)
  // ---------------------------------------------------------------------------
  createInviteLink(data: {
    code: string;
    communityId: string;
    createdBy: string;
    maxUses: number | null;
    expiresAt: Date | null;
  }) {
    return prisma.communityInviteLink.create({ data });
  },

  findInviteLinkById(linkId: string) {
    return prisma.communityInviteLink.findUnique({ where: { id: linkId } });
  },

  findInviteLinkByCode(code: string) {
    return prisma.communityInviteLink.findUnique({ where: { code } });
  },

  async listInviteLinks(params: {
    communityId: string;
    status?: "active" | "expired" | "revoked";
    page: number;
    limit: number;
  }) {
    const now = new Date();
    const where: Prisma.CommunityInviteLinkWhereInput = {
      communityId: params.communityId,
    };
    if (params.status === "revoked") {
      where.revokedAt = { not: null };
    } else if (params.status === "expired") {
      where.revokedAt = null;
      where.expiresAt = { lt: now };
    } else if (params.status === "active") {
      where.revokedAt = null;
      where.OR = [{ expiresAt: null }, { expiresAt: { gt: now } }];
    }
    const [rows, total] = await Promise.all([
      prisma.communityInviteLink.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.communityInviteLink.count({ where }),
    ]);
    return { rows, total };
  },

  updateInviteLink(
    linkId: string,
    data: Prisma.CommunityInviteLinkUpdateInput
  ) {
    return prisma.communityInviteLink.update({
      where: { id: linkId },
      data,
    });
  },

  /**
   * Capacity-guarded increment via optimistic concurrency: load → check →
   * conditional update on the observed `usedCount`. Prisma's field-to-field
   * comparison (`fields.maxUses`) in Mongo `updateMany` is unreliable, so we
   * snapshot the count, then `updateMany` filtered by that exact value — if
   * another redeemer beat us, `count` is 0 and we retry up to 3 times. This
   * avoids `$transaction` (unavailable on standalone Mongo).
   */
  async incrementInviteLinkUsageIfUnder(linkId: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const link = await prisma.communityInviteLink.findUnique({
        where: { id: linkId },
      });
      if (!link) return { count: 0 };
      if (link.maxUses !== null && link.usedCount >= link.maxUses) {
        return { count: 0 };
      }
      const result = await prisma.communityInviteLink.updateMany({
        where: { id: linkId, usedCount: link.usedCount },
        data: { usedCount: { increment: 1 } },
      });
      if (result.count === 1) return { count: 1 };
      // Concurrent redeemer beat us — loop and re-read.
    }
    return { count: 0 };
  },
};
