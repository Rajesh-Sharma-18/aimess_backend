import { prisma } from "../config/prisma.js";
import {
  CommunityMemberRole,
  CommunityMemberStatus,
  type CommunityType,
  type Prisma,
} from "../generated/prisma/index.js";

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
  }) {
    return prisma.communityMember.create({ data });
  },

  /** Bulk insert members (single-collection — safe without a replica set). */
  createManyMembers(
    communityId: string,
    userIds: string[],
    role: CommunityMemberRole = CommunityMemberRole.MEMBER,
    status: CommunityMemberStatus = CommunityMemberStatus.ACTIVE
  ) {
    return prisma.communityMember.createMany({
      data: userIds.map((userId) => ({ communityId, userId, role, status })),
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
};
