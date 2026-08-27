import {
  ProfileStatus,
  type ProfileGender,
  type Prisma,
} from "../generated/prisma/client.js";
import { prisma } from "../config/prisma.js";
import { normalizeUsername } from "../lib/username.util.js";
import {
  normalizeForSearch,
  buildUserSearchFilter,
  buildNormalizedFullName,
} from "../lib/user-search.util.js";
import { PLACEHOLDER_DATE_OF_BIRTH } from "../lib/profile-fields.util.js";
import {
  discoverableWhere,
  type ViewerGraph,
  PRIVACY_SCOPE_SELECT,
} from "../lib/privacy-scope.js";

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
  // Carried so the mapper can mask presence / gated fields per viewer without a
  // second query — see `visibleIsOnline` / `canViewProfile`.
  privacySettings: PRIVACY_SCOPE_SELECT,
} as const;

function buildSearchFilter(q: string | undefined): {
  AND?: Prisma.UserProfileWhereInput[];
} {
  if (!q) return {};
  return { AND: buildUserSearchFilter(q) };
}

/**
 * `where` for any viewer-facing user listing: the text filter AND the
 * `whoCanFindMe` discovery gate.
 *
 * `viewer` is REQUIRED on every discovery query rather than defaulting to an
 * empty graph — a forgotten argument must be a type error, not a silent
 * privacy-leaking open search.
 */
function buildDiscoveryWhere(
  q: string | undefined,
  viewer: ViewerGraph
): Prisma.UserProfileWhereInput {
  // Both clauses land in AND — `buildSearchFilter` already owns that key, so
  // concatenate instead of spreading (a spread would silently drop the search).
  return {
    AND: [...(buildSearchFilter(q).AND ?? []), discoverableWhere(viewer)],
  };
}

export const userProfileRepository = {
  /**
   * Full row for a THIRD-PARTY profile read, plus the privacy scopes that gate
   * it — one query, so the endpoint never does a second round-trip for settings.
   * Separate from the cached [findByUserId] path: that cache stores only the
   * self-profile subset (no presence, counts, cover or privacy).
   */
  findPublicProfileByUserId(userId: string) {
    return prisma.userProfile.findUnique({
      where: { userId },
      select: {
        userId: true,
        username: true,
        firstName: true,
        lastName: true,
        bio: true,
        avatarUrl: true,
        coverImageUrl: true,
        isOnline: true,
        lastSeenAt: true,
        friendsCount: true,
        communitiesCount: true,
        groupsCount: true,
        status: true,
        deletedAt: true,
        privacySettings: PRIVACY_SCOPE_SELECT,
      },
    });
  },

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

  /**
   * Like {@link findByUserIds}, but applies the `whoCanFindMe` gate — for
   * viewer-facing surfaces (recent searches, pickers). Deliberately a SEPARATE
   * method rather than an optional flag on `findByUserIds`: that one still
   * backs the block list and internal enrichment, where a user who hid
   * themselves from search must NOT vanish from the viewer's own block list.
   */
  findDiscoverableByUserIds(userIds: string[], viewer: ViewerGraph) {
    return prisma.userProfile.findMany({
      where: {
        userId: { in: userIds },
        deletedAt: null,
        ...discoverableWhere(viewer),
      },
      select: DISCOVERY_SELECT,
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

  async updateProfile(
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
    // Keep the normalized search shadows in sync whenever the searchable
    // fields change — mirrors community's updateCommunity guard pattern.
    const patch: typeof data & {
      normalizedUsername?: string;
      normalizedFirstName?: string;
      normalizedLastName?: string;
      normalizedFullName?: string;
    } = { ...data };
    if (data.username !== undefined) {
      patch.normalizedUsername = normalizeForSearch(data.username);
    }
    if (data.firstName !== undefined) {
      patch.normalizedFirstName = normalizeForSearch(data.firstName);
    }
    if (data.lastName !== undefined) {
      patch.normalizedLastName = normalizeForSearch(data.lastName);
    }
    if (data.firstName !== undefined || data.lastName !== undefined) {
      // normalizedFullName needs BOTH names — fetch whichever side isn't
      // part of this patch so a single-field update still recomputes it
      // correctly (e.g. editing just lastName still fixes the shadow).
      let { firstName, lastName } = data;
      if (firstName === undefined || lastName === undefined) {
        const current = await prisma.userProfile.findUnique({
          where: { userId },
          select: { firstName: true, lastName: true },
        });
        firstName ??= current?.firstName ?? "";
        lastName ??= current?.lastName ?? "";
      }
      patch.normalizedFullName = buildNormalizedFullName(firstName, lastName);
    }
    return prisma.userProfile.update({
      where: { userId },
      data: patch,
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
    take: number,
    viewer: ViewerGraph
  ) {
    return prisma.userProfile.findMany({
      where: {
        userId: { in: userIds },
        deletedAt: null,
        ...buildDiscoveryWhere(q, viewer),
      },
      select: DISCOVERY_SELECT,
      skip,
      take,
      orderBy: { firstName: "asc" },
    });
  },

  countUsersInList(
    userIds: string[],
    q: string | undefined,
    viewer: ViewerGraph
  ) {
    return prisma.userProfile.count({
      where: {
        userId: { in: userIds },
        deletedAt: null,
        ...buildDiscoveryWhere(q, viewer),
      },
    });
  },

  findUsersNotInList(
    excludeIds: string[],
    q: string | undefined,
    skip: number,
    take: number,
    viewer: ViewerGraph
  ) {
    return prisma.userProfile.findMany({
      where: {
        userId: { notIn: excludeIds },
        deletedAt: null,
        ...buildDiscoveryWhere(q, viewer),
      },
      select: DISCOVERY_SELECT,
      skip,
      take,
      orderBy: { firstName: "asc" },
    });
  },

  countUsersNotInList(
    excludeIds: string[],
    q: string | undefined,
    viewer: ViewerGraph
  ) {
    return prisma.userProfile.count({
      where: {
        userId: { notIn: excludeIds },
        deletedAt: null,
        ...buildDiscoveryWhere(q, viewer),
      },
    });
  },

  /**
   * Backs the `BulkGetUserSnapshots` RPC — the identity source every other
   * service reads. Deliberately does NOT filter `deletedAt: null`, unlike the
   * discovery/search selects above.
   *
   * Excluding deleted rows here did not hide the deleted user; it only made
   * this RPC return a GAP, and every caller filled that gap from somewhere
   * worse — chat-service fell through to auth-service's login `account`
   * (leaking the old handle), community-service kept serving the denormalized
   * member snapshot (leaking the old name and avatar), and the rest rendered
   * an empty name. Returning the row with `deletedAt` set lets the RPC hand
   * back one anonymized representation that every caller renders identically.
   */
  findManyByUserIds(userIds: string[]) {
    return prisma.userProfile.findMany({
      where: { userId: { in: userIds } },
      select: {
        userId: true,
        username: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        deletedAt: true,
        status: true,
      },
    });
  },

  createFromRegistration(params: {
    userId: string;
    account: string;
    username: string;
    /** Already-resolved seed name — caller applies the placeholder fallback. */
    firstName: string;
    lastName: string;
    isGoogleLogin?: boolean;
  }) {
    const { userId, account, username, firstName, lastName, isGoogleLogin } =
      params;

    return prisma.$transaction(async (tx) => {
      const profile = await tx.userProfile.create({
        data: {
          userId,
          account,
          username,
          normalizedUsername: normalizeForSearch(username),
          firstName,
          normalizedFirstName: normalizeForSearch(firstName),
          lastName,
          normalizedLastName: normalizeForSearch(lastName),
          normalizedFullName: buildNormalizedFullName(firstName, lastName),
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

  /**
   * Admin mirror of an account ban/suspend/reinstate (backoffice → gRPC
   * AdminSetProfileStatus). Only ACTIVE <-> SUSPENDED; a DELETED profile is
   * terminal and is left alone so a late ban event cannot resurrect it.
   */
  adminSetStatus(userId: string, status: ProfileStatus) {
    return prisma.userProfile.updateMany({
      where: {
        userId,
        deletedAt: null,
        status: { not: ProfileStatus.DELETED },
      },
      data: { status },
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
