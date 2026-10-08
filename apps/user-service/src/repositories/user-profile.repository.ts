import {
  Prisma,
  ProfileStatus,
  type ProfileGender,
} from "../generated/prisma/client.js";
import { prisma } from "../config/prisma.js";
import { normalizeUsername } from "../lib/username.util.js";
import {
  normalizeForSearch,
  buildUserSearchFilter,
  buildNormalizedFullName,
  type PeopleSearchCursor,
} from "../lib/user-search.util.js";
import { PLACEHOLDER_DATE_OF_BIRTH } from "../lib/profile-fields.util.js";
import {
  discoverableWhere,
  type ViewerGraph,
  PRIVACY_SCOPE_SELECT,
} from "../lib/privacy-scope.js";

export const CUSTOM_STATUS_SELECT = {
  customStatusEmoji: true,
  customStatusText: true,
  customStatusStartedAt: true,
  customStatusExpiresAt: true,
  customStatusUpdatedAt: true,
} as const;

export type CustomStatusColumns = {
  customStatusEmoji: string | null;
  customStatusText: string | null;
  customStatusStartedAt: Date | null;
  customStatusExpiresAt: Date | null;
  customStatusUpdatedAt: Date | null;
};

export type CustomStatusWriteRow = { userId: string };

const CLEAR_CUSTOM_STATUS_SQL = Prisma.sql`"customStatusEmoji" = NULL, "customStatusText" = NULL,
  "customStatusStartedAt" = NULL, "customStatusExpiresAt" = NULL`;

/** Maximum users returned by findAllActiveExcept — prevents full-table scans on large deployments. */
const AUTO_CONNECT_USER_LIMIT = 10_000;

/**
 * The account-state half of "may a viewer-facing listing return this row at
 * all" — merged into EVERY people-discovery query below (search, the exact
 * -handle head, recent searches, the friends/"Add Members" picker and their
 * count twins), so a single rule decides discoverability instead of each query
 * restating it.
 *
 * BANNED is the permanent Super Admin system ban, mirrored here from backoffice
 * over `AdminSetProfileStatus`. A banned account cannot log in, cannot accept a
 * friend request and cannot be added to anything, so surfacing it in people
 * search only leaks the existence of a moderated account. Excluding it in the
 * WHERE (rather than dropping rows from an already-paginated page) is what
 * keeps `count`, `hasMore` and the keyset cursor honest — a post-filter would
 * return short pages and over-report totals.
 *
 * Deliberately NOT excluded:
 *   - SUSPENDED — a time-boxed restriction. NOTHING in this service expires it
 *     (there is no sweeper anywhere; the mirror only changes when an admin acts),
 *     so hiding it here would turn a three-day suspension into permanent
 *     invisibility. That is a separate decision from this one, and it is not
 *     the one the ban needs.
 *   - DELETED — already covered by the `deletedAt: null` each query carries;
 *     the status is the same fact written twice.
 *
 * Admin surfaces (`adminGetProfile`, `adminSearchProfileIds`,
 * `adminGetProfilesByIds`) and the identity RPC (`findManyByUserIds`) must NOT
 * use this — the panel has to keep finding banned users, and history has to keep
 * rendering their name.
 */
const DISCOVERABLE_ACCOUNT_WHERE = {
  status: { not: ProfileStatus.BANNED },
} as const satisfies Prisma.UserProfileWhereInput;

/**
 * DISCOVERY additionally requires a completed profile — the same three fields
 * `isProfileComplete` checks. Registration reserves an account-derived username
 * that `allocatedUsername()` blanks for other viewers, so an abandoned
 * onboarding used to surface as a nameless row that still MATCHED on the
 * hidden handle (confirming the account exists) and, sorting on an empty
 * `firstName`, led every page. In the WHERE for the same reason as the ban:
 * counts, `hasMore` and the keyset stay honest.
 *
 * Not applied to `findUsersInList` (the viewer's accepted friends): that list
 * is already authorized, exactly like the `whoCanFindMe` exemption there.
 */
const DISCOVERABLE_PROFILE_WHERE = {
  ...DISCOVERABLE_ACCOUNT_WHERE,
  username: { not: "" },
  firstName: { not: "" },
  lastName: { not: "" },
} as const satisfies Prisma.UserProfileWhereInput;

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
  viewer: ViewerGraph,
  cursor?: PeopleSearchCursor,
  alwaysVisibleIds?: string[]
): Prisma.UserProfileWhereInput {
  // Both clauses land in AND — `buildSearchFilter` already owns that key, so
  // concatenate instead of spreading (a spread would silently drop the search).
  return {
    AND: [
      ...(buildSearchFilter(q).AND ?? []),
      // `alwaysVisibleIds` widens the `whoCanFindMe` gate for ids the CALLER
      // has already authorized — never `discoverableWhere` itself, which three
      // other queries share. Every other clause (text, deletedAt, excludeIds,
      // keyset) still applies to those rows.
      discoverableWhere(viewer, alwaysVisibleIds),
      // Keyset "after" for orderBy [firstName asc, userId asc]. Same collation
      // drives both the sort and this comparison, so the two agree by
      // construction — which is the whole reason skip is droppable.
      ...(cursor
        ? [
            {
              OR: [
                { firstName: { gt: cursor.firstName } },
                { firstName: cursor.firstName, userId: { gt: cursor.userId } },
              ],
            },
          ]
        : []),
    ],
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
        ...CUSTOM_STATUS_SELECT,
        privacySettings: PRIVACY_SCOPE_SELECT,
      },
    });
  },

  findCustomStatus(userId: string): Promise<CustomStatusColumns | null> {
    return prisma.userProfile.findUnique({
      where: { userId },
      select: CUSTOM_STATUS_SELECT,
    });
  },

  // Raw SQL so the profile's @updatedAt (the profile_updated ordering key) is not bumped.
  async setCustomStatus(
    userId: string,
    s: { emoji: string | null; text: string | null; startedAt: Date; expiresAt: Date }
  ): Promise<CustomStatusWriteRow | null> {
    const rows = await prisma.$queryRaw<CustomStatusWriteRow[]>`
      UPDATE "user_profiles" p SET
        "customStatusEmoji" = ${s.emoji}, "customStatusText" = ${s.text},
        "customStatusStartedAt" = ${s.startedAt}, "customStatusExpiresAt" = ${s.expiresAt},
        "customStatusUpdatedAt" = ${s.startedAt}
      WHERE p."userId" = ${userId}::uuid AND p."deletedAt" IS NULL
      RETURNING p."userId"`;
    return rows[0] ?? null;
  },

  /** No-op (empty result) when nothing is set, so a repeated clear emits nothing. */
  async clearCustomStatus(userId: string, now: Date): Promise<CustomStatusWriteRow | null> {
    const rows = await prisma.$queryRaw<CustomStatusWriteRow[]>`
      UPDATE "user_profiles" p SET ${CLEAR_CUSTOM_STATUS_SQL}, "customStatusUpdatedAt" = ${now}
      WHERE p."userId" = ${userId}::uuid AND p."customStatusExpiresAt" IS NOT NULL
      RETURNING p."userId"`;
    return rows[0] ?? null;
  },

  /** Atomic claim: concurrent sweepers re-check the WHERE after the row lock, so each row is claimed once. */
  claimExpiredCustomStatuses(now: Date, limit: number): Promise<CustomStatusWriteRow[]> {
    return prisma.$queryRaw<CustomStatusWriteRow[]>`
      UPDATE "user_profiles" p SET ${CLEAR_CUSTOM_STATUS_SQL}, "customStatusUpdatedAt" = ${now}
      WHERE p."userId" IN (
        SELECT "userId" FROM "user_profiles"
        WHERE "customStatusExpiresAt" <= ${now}
        LIMIT ${limit} FOR UPDATE SKIP LOCKED
      ) AND p."customStatusExpiresAt" <= ${now}
      RETURNING p."userId"`;
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
        ...DISCOVERABLE_PROFILE_WHERE,
        ...discoverableWhere(viewer),
      },
      select: DISCOVERY_SELECT,
    });
  },

  /**
   * The exact-`@handle` head of people search: ONE row, or none.
   *
   * The page below it is a keyset walk ordered `firstName asc, userId asc`, so
   * a handle-exact hit has no way to reach the top on its own — search
   * `cat` on a platform with 200 handles containing "cat" and `@cat` itself
   * lands wherever its owner's first name falls. That is the single most
   * visible way a handle search feels broken, and it is not fixable by sorting
   * a page: the row is not IN the first page.
   *
   * Same `whoCanFindMe` gate and the same `alwaysVisibleIds` widening as the
   * page query — an exact handle is a better query, not a permission. A user
   * who hid themselves from discovery stays hidden here too.
   */
  findDiscoverableByNormalizedUsername(
    normalizedUsername: string,
    viewer: ViewerGraph,
    alwaysVisibleIds?: string[]
  ) {
    return prisma.userProfile.findFirst({
      where: {
        normalizedUsername,
        deletedAt: null,
        ...DISCOVERABLE_PROFILE_WHERE,
        ...discoverableWhere(viewer, alwaysVisibleIds),
      },
      select: DISCOVERY_SELECT,
    });
  },

  /**
   * Case-insensitive — canonical storage is lowercase; legacy rows may differ in
   * casing. Prisma's `mode: "insensitive"` is an ILIKE, where `_` (legal in
   * every username) is a wildcard, so it is escaped: unescaped, "test_c" found
   * "testxc" and was reported taken.
   */
  findByUsername(username: string) {
    const normalized = normalizeUsername(username).replace(/[\\%_]/g, "\\$&");
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

  /**
   * Rows from an EXPLICIT id list — today only the viewer's own accepted
   * friends (friends picker, search "chat" bucket).
   *
   * Deliberately NOT gated by `whoCanFindMe`: that scope decides who may
   * DISCOVER you, not whether a person you already accepted still shows up in
   * their own friend list. Applying it here hid every friend who had set
   * `NO_ONE` from the picker while `GET /users/friends` still listed them.
   * Callers must therefore pass an id list they have already authorized.
   */
  findUsersInList(
    userIds: string[],
    q: string | undefined,
    skip: number,
    take: number
  ) {
    return prisma.userProfile.findMany({
      where: {
        userId: { in: userIds },
        deletedAt: null,
        ...DISCOVERABLE_ACCOUNT_WHERE,
        ...buildSearchFilter(q),
      },
      select: DISCOVERY_SELECT,
      skip,
      take,
      // userId breaks ties: `firstName` alone is not unique, and an unstable
      // sort under skip/take drops and duplicates rows across pages.
      orderBy: [{ firstName: "asc" }, { userId: "asc" }],
    });
  },

  countUsersInList(userIds: string[], q: string | undefined) {
    return prisma.userProfile.count({
      where: {
        userId: { in: userIds },
        deletedAt: null,
        ...DISCOVERABLE_ACCOUNT_WHERE,
        ...buildSearchFilter(q),
      },
    });
  },

  /**
   * `cursor` and `skip` are alternatives, not a pair: a cursor walks the
   * [firstName, userId] keyset and makes `skip` meaningless, so it is dropped.
   * Offset callers (discovery pages) simply omit the cursor.
   *
   * `alwaysVisibleIds` are ids exempt from the `whoCanFindMe` gate because the
   * caller already authorized them — today only the viewer's existing
   * private-room peers (user search), never a set the viewer merely matched.
   */
  findUsersNotInList(
    excludeIds: string[],
    q: string | undefined,
    skip: number,
    take: number,
    viewer: ViewerGraph,
    cursor?: PeopleSearchCursor,
    alwaysVisibleIds?: string[]
  ) {
    return prisma.userProfile.findMany({
      where: {
        userId: { notIn: excludeIds },
        deletedAt: null,
        ...DISCOVERABLE_PROFILE_WHERE,
        ...buildDiscoveryWhere(q, viewer, cursor, alwaysVisibleIds),
      },
      select: DISCOVERY_SELECT,
      skip: cursor ? undefined : skip,
      take,
      // Tiebreaker: `firstName` is not unique, and an unstable sort under
      // skip/take drops and duplicates rows across pages.
      orderBy: [{ firstName: "asc" }, { userId: "asc" }],
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
        ...DISCOVERABLE_PROFILE_WHERE,
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
   * AdminSetProfileStatus). ACTIVE, SUSPENDED or BANNED; a DELETED profile is
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
   * Exact inverse of {@link softDelete}. Only the two markers are written —
   * `softDelete` overwrote nothing else, so username, names, bio, avatar,
   * date of birth and every other column are still the values the account had
   * before deletion and simply become visible again.
   */
  restore(userId: string) {
    return prisma.userProfile.update({
      where: { userId },
      data: { deletedAt: null, status: ProfileStatus.ACTIVE },
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
