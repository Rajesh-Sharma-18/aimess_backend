import { prisma } from "../config/prisma.js";
import {
  CommunityMemberRole,
  CommunityMemberStatus,
  type CommunityType,
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

  /** Members of a community filtered by status — cursor pagination on id. */
  listMembers(params: {
    communityId: string;
    status: CommunityMemberStatus;
    limit: number;
    cursor?: string;
  }) {
    return prisma.communityMember.findMany({
      where: { communityId: params.communityId, status: params.status },
      orderBy: { id: "asc" },
      take: params.limit + 1,
      ...(params.cursor ? { skip: 1, cursor: { id: params.cursor } } : {}),
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

  /** Communities where the caller is an ACTIVE member — cursor pagination on id. */
  listMyMemberships(params: {
    userId: string;
    limit: number;
    cursor?: string;
  }) {
    return prisma.communityMember.findMany({
      where: {
        userId: params.userId,
        status: CommunityMemberStatus.ACTIVE,
        community: { deletedAt: { isSet: false } },
      },
      orderBy: { id: "asc" },
      take: params.limit + 1,
      ...(params.cursor ? { skip: 1, cursor: { id: params.cursor } } : {}),
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
    });
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
   * ordering on `id` desc matches createdAt order; cursor pagination keys on id.
   */
  listAuditLogs(params: {
    communityId: string;
    limit: number;
    cursor?: string;
  }) {
    return prisma.communityAuditLog.findMany({
      where: { communityId: params.communityId },
      orderBy: { id: "desc" },
      take: params.limit + 1,
      ...(params.cursor ? { skip: 1, cursor: { id: params.cursor } } : {}),
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
    });
  },
};
