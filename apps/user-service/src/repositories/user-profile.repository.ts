import {
  ProfileStatus,
  type ProfileGender,
  type Prisma,
} from "../generated/prisma/client.js";
import { prisma } from "../config/prisma.js";
import { normalizeUsername } from "../lib/username.util.js";

const PLACEHOLDER_DATE_OF_BIRTH = new Date("2000-01-01");

/** Maximum users returned by findAllActiveExcept — prevents full-table scans on large deployments. */
const AUTO_CONNECT_USER_LIMIT = 10_000;

const DISCOVERY_SELECT = {
  userId: true,
  username: true,
  firstName: true,
  lastName: true,
  bio: true,
  avatarUrl: true,
  isOnline: true,
} as const;

function buildSearchFilter(q: string | undefined) {
  if (!q) return {};
  return {
    OR: [
      { username: { contains: q, mode: "insensitive" as const } },
      { firstName: { contains: q, mode: "insensitive" as const } },
      { lastName: { contains: q, mode: "insensitive" as const } },
    ],
  };
}

export const userProfileRepository = {
  findByUserId(userId: string) {
    return prisma.userProfile.findUnique({ where: { userId } });
  },

  /** Case-insensitive — canonical storage is lowercase; legacy rows may differ in casing. */
  findByUserIds(userIds: string[]) {
    return prisma.userProfile.findMany({
      where: { userId: { in: userIds }, deletedAt: null },
      select: {
        userId: true,
        username: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        isOnline: true,
      },
    });
  },

  /** Case-insensitive — canonical storage is lowercase; legacy rows may differ in casing. */
  findByUsername(username: string) {
    const normalized = normalizeUsername(username);
    return prisma.userProfile.findFirst({
      where: {
        username: { equals: normalized, mode: "insensitive" },
      },
    });
  },

  updateProfile(
    userId: string,
    data: {
      firstName?: string;
      lastName?: string;
      username?: string;
      bio?: string | null;
      dateOfBirth?: Date;
      gender?: ProfileGender | null;
      avatarUrl?: string | null;
      lastUsernameChangeAt?: Date;
    }
  ) {
    return prisma.userProfile.update({
      where: { userId },
      data,
      select: {
        userId: true,
        username: true,
        account: true,
        firstName: true,
        lastName: true,
        bio: true,
        dateOfBirth: true,
        gender: true,
        avatarUrl: true,
        isGoogleLogin: true,
        updatedAt: true,
      },
    });
  },

  findUsersInList(
    userIds: string[],
    q: string | undefined,
    skip: number,
    take: number
  ) {
    const searchFilter = buildSearchFilter(q);
    return prisma.userProfile.findMany({
      where: { userId: { in: userIds }, deletedAt: null, ...searchFilter },
      select: DISCOVERY_SELECT,
      skip,
      take,
      orderBy: { firstName: "asc" },
    });
  },

  countUsersInList(userIds: string[], q: string | undefined) {
    const searchFilter = buildSearchFilter(q);
    return prisma.userProfile.count({
      where: { userId: { in: userIds }, deletedAt: null, ...searchFilter },
    });
  },

  findUsersNotInList(
    excludeIds: string[],
    q: string | undefined,
    skip: number,
    take: number
  ) {
    const searchFilter = buildSearchFilter(q);
    return prisma.userProfile.findMany({
      where: {
        userId: { notIn: excludeIds },
        deletedAt: null,
        ...searchFilter,
      },
      select: DISCOVERY_SELECT,
      skip,
      take,
      orderBy: { firstName: "asc" },
    });
  },

  countUsersNotInList(excludeIds: string[], q: string | undefined) {
    const searchFilter = buildSearchFilter(q);
    return prisma.userProfile.count({
      where: {
        userId: { notIn: excludeIds },
        deletedAt: null,
        ...searchFilter,
      },
    });
  },

  findManyByUserIds(userIds: string[]) {
    return prisma.userProfile.findMany({
      where: { userId: { in: userIds }, deletedAt: null },
      select: {
        userId: true,
        username: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
      },
    });
  },

  createFromRegistration(params: {
    userId: string;
    account: string;
    username: string;
    displayName: string;
    isGoogleLogin?: boolean;
  }) {
    const { userId, account, username, displayName, isGoogleLogin } = params;

    return prisma.$transaction(async (tx) => {
      const profile = await tx.userProfile.create({
        data: {
          userId,
          account,
          username,
          firstName: displayName,
          lastName: "User",
          dateOfBirth: PLACEHOLDER_DATE_OF_BIRTH,
          isGoogleLogin,
        },
      });

      await tx.privacySettings.create({ data: { userId } });
      await tx.chatSettings.create({ data: { userId } });
      await tx.appSettings.create({ data: { userId } });
      await tx.notificationSettings.create({ data: { userId } });
      await tx.liveStreamSettings.create({ data: { userId } });

      return profile;
    });
  },

  /**
   * Release a denormalized `account` held by a stale/orphaned profile so a new
   * registration can claim it. Safe because auth_users.account is globally unique
   * among live users — any profile sharing this account belongs to a deleted user.
   */
  clearAccountValue(account: string) {
    return prisma.userProfile.updateMany({
      where: { account },
      data: { account: null },
    });
  },

  softDelete(userId: string, deletedAt: Date) {
    return prisma.userProfile.update({
      where: { userId },
      data: { deletedAt, status: ProfileStatus.DELETED },
    });
  },

  /**
   * Admin Panel: enrich a user list with display profile data.
   * Returns rows for the subset of `userIds` that exist (no order guarantee).
   * Guards empty input to avoid an unnecessary query.
   */
  adminGetProfilesByIds(userIds: string[]) {
    if (userIds.length === 0) return Promise.resolve([]);
    return prisma.userProfile.findMany({
      where: { userId: { in: userIds } },
      select: {
        userId: true,
        username: true,
        avatarUrl: true,
        firstName: true,
        lastName: true,
        createdAt: true,
      },
    });
  },

  /**
   * Admin Panel (Reports search): match userIds by username, first/last name,
   * or full name (split on the first whitespace so "John Doe" matches either
   * name order). Capped at 500 — the caller only needs an id-set to filter by,
   * not a page of results.
   */
  adminSearchProfileIds(search: string): Promise<string[]> {
    const term = search.trim();
    if (!term) return Promise.resolve([]);

    const or: Prisma.UserProfileWhereInput[] = [
      { username: { contains: term, mode: "insensitive" } },
      { firstName: { contains: term, mode: "insensitive" } },
      { lastName: { contains: term, mode: "insensitive" } },
    ];
    const parts = term.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const first = parts[0]!;
      const rest = parts.slice(1).join(" ");
      or.push(
        {
          AND: [
            { firstName: { contains: first, mode: "insensitive" } },
            { lastName: { contains: rest, mode: "insensitive" } },
          ],
        },
        {
          AND: [
            { firstName: { contains: rest, mode: "insensitive" } },
            { lastName: { contains: first, mode: "insensitive" } },
          ],
        }
      );
    }

    return prisma.userProfile
      .findMany({
        where: { OR: or },
        select: { userId: true },
        take: 500,
      })
      .then((rows) => rows.map((r) => r.userId));
  },

  /** Admin Panel: single profile lookup by id, or null when absent. */
  adminGetProfile(userId: string) {
    return prisma.userProfile.findUnique({
      where: { userId },
      select: {
        userId: true,
        username: true,
        avatarUrl: true,
        firstName: true,
        lastName: true,
        createdAt: true,
      },
    });
  },

  /**
   * Returns up to AUTO_CONNECT_USER_LIMIT active (non-deleted) profiles, excluding
   * the caller. The cap prevents a full-table scan from loading millions of rows into
   * memory on large deployments.
   */
  findAllActiveExcept(callerId: string): Promise<{ userId: string }[]> {
    return prisma.userProfile.findMany({
      where: {
        userId: { not: callerId },
        status: ProfileStatus.ACTIVE,
        deletedAt: null,
      },
      select: { userId: true },
      take: AUTO_CONNECT_USER_LIMIT,
    });
  },
};
