import { UnauthorizedError } from "@aimess/errors";

import {
  anonymizedAccountFields,
  anonymizedLinkedAccountFields,
} from "../lib/account-anonymize.js";
import { prisma } from "../config/prisma.js";
import {
  AccountStatus,
  AuthProvider,
  SessionRevokeReason,
  type DeviceType,
  type Prisma,
} from "../generated/prisma/client.js";
import {
  assertCanLinkIdentity,
  type LinkedIdentityState,
} from "../lib/linked-identity.js";

/**
 * Locks the account row FOR UPDATE, then reads its identity state. Every
 * identity-adding write takes this lock first, so two concurrent links on one
 * account serialize and the second sees the first one's committed row.
 */
async function lockLinkedIdentityState(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<LinkedIdentityState> {
  await tx.$queryRaw`SELECT id FROM auth_users WHERE id = ${userId}::uuid FOR UPDATE`;

  const state = await tx.authUser.findUnique({
    where: { id: userId },
    select: {
      email: true,
      emailVerified: true,
      _count: { select: { linkedAccounts: true } },
    },
  });

  if (!state) {
    throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
  }

  return state;
}

/**
 * Rows whose account equals `account` ignoring case, the exact-case row first.
 * At most two: callers only tell "none / one / ambiguous" apart. Served by the
 * `auth_users_account_lower_key` expression index — Prisma's `mode:
 * "insensitive"` is an unescaped ILIKE, where the `_` every handle may contain
 * is a wildcard ("test_c" matched "testXc").
 */
function accountMatchesIgnoringCase(
  account: string
): Promise<{ id: string; exact: boolean }[]> {
  return prisma.$queryRaw`
    SELECT id::text AS id, account = ${account} AS exact
    FROM auth_users
    WHERE lower(account) = lower(${account})
    ORDER BY exact DESC
    LIMIT 2`;
}

const loginUserSelect = {
  id: true,
  account: true,
  email: true,
  emailVerified: true,
  passwordHash: true,
  status: true,
  lockedUntil: true,
  deletedAt: true,
  isProfileCompleted: true,
  role: true,
  // Read ONLY when `passwordHash` is null, to name the provider(s) a
  // password-less account must sign in with. Selected here rather than fetched
  // in a second query because the login path is hot and this costs one join on
  // a row that is already being read. See lib/sign-in-methods.ts.
  linkedAccounts: { select: { provider: true } },
} as const;

export const authRepository = {
  findByEmail(email: string) {
    return prisma.authUser.findUnique({ where: { email } });
  },

  findEmailTakenByOtherUser(email: string, excludeUserId: string) {
    return prisma.authUser.findFirst({
      where: {
        email,
        id: { not: excludeUserId },
      },
      select: { id: true },
    });
  },

  findByIdForEmailLink(userId: string) {
    return prisma.authUser.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        emailVerified: true,
        status: true,
        deletedAt: true,
        _count: { select: { linkedAccounts: true } },
      },
    });
  },

  findByIdForAccountOps(userId: string) {
    return prisma.authUser.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        emailVerified: true,
        passwordHash: true,
        status: true,
        deletedAt: true,
      },
    });
  },

  findAccountSummaryByUserId(userId: string) {
    return prisma.authUser.findUnique({
      where: { id: userId },
      select: {
        id: true,
        account: true,
        email: true,
        emailVerified: true,
        primaryAccount: true,
        linkedAccounts: {
          select: {
            provider: true,
            providerUserId: true,
            email: true,
            linkedAt: true,
          },
        },
      },
    });
  },

  updateVerifiedEmail(userId: string, email: string) {
    return prisma.authUser.update({
      where: { id: userId },
      data: {
        email,
        emailVerified: true,
      },
      select: {
        id: true,
        emailVerified: true,
      },
    });
  },

  /**
   * Sets the user's primary account exactly once. The `primaryAccount: null`
   * guard in the WHERE makes this an atomic no-op when a value is already
   * present, so the first linked provider wins and is never overwritten even
   * under concurrent link requests.
   *
   * The `updateMany` and subsequent `findUnique` are wrapped in a single
   * Prisma interactive transaction so that a concurrent read (e.g. a gRPC
   * getAccountSummary call) can never observe the intermediate state where
   * the updateMany has not yet committed but the findUnique has already read.
   */
  async setPrimaryAccountIfUnset(userId: string, provider: AuthProvider) {
    return prisma.$transaction(async (tx) => {
      await tx.authUser.updateMany({
        where: { id: userId, primaryAccount: null },
        data: { primaryAccount: provider },
      });

      const row = await tx.authUser.findUnique({
        where: { id: userId },
        select: { primaryAccount: true },
      });

      return row?.primaryAccount ?? null;
    });
  },

  /**
   * Atomically links a verified email and promotes EMAIL to the user's primary
   * account if none has been set yet. Combines what were previously two
   * sequential repository calls (`linkVerifiedEmail` + `setPrimaryAccountIfUnset`)
   * into a single Prisma interactive transaction, eliminating the race window
   * where a concurrent getAccountSummary gRPC call could read email=set but
   * primaryAccount=null.
   */
  async linkVerifiedEmailAndSetPrimary(
    userId: string,
    email: string,
    provider: AuthProvider
  ) {
    return prisma.$transaction(async (tx) => {
      assertCanLinkIdentity(await lockLinkedIdentityState(tx, userId));

      const updated = await tx.authUser.update({
        where: { id: userId },
        data: { email, emailVerified: true },
        select: { id: true, email: true, emailVerified: true },
      });

      await tx.authUser.updateMany({
        where: { id: userId, primaryAccount: null },
        data: { primaryAccount: provider },
      });

      const row = await tx.authUser.findUnique({
        where: { id: userId },
        select: { primaryAccount: true },
      });

      return { ...updated, primaryAccount: row?.primaryAccount ?? null };
    });
  },

  /**
   * Adds a Google/Apple link under the same row lock the email link takes, so
   * a concurrent email link and social link cannot both pass the one-identity
   * check. Returns the (possibly just stamped) primaryAccount.
   */
  async linkSocialAccount(params: {
    userId: string;
    provider: AuthProvider;
    providerUserId: string;
    email: string | null;
    emailVerified: boolean;
    displayName: string | null;
  }) {
    return prisma.$transaction(async (tx) => {
      assertCanLinkIdentity(await lockLinkedIdentityState(tx, params.userId));

      await tx.linkedAccount.create({
        data: {
          userId: params.userId,
          provider: params.provider,
          providerUserId: params.providerUserId,
          email: params.email ?? undefined,
          emailVerified: params.emailVerified,
          displayName: params.displayName ?? undefined,
        },
      });

      await tx.authUser.updateMany({
        where: { id: params.userId, primaryAccount: null },
        data: { primaryAccount: params.provider },
      });

      const row = await tx.authUser.findUnique({
        where: { id: params.userId },
        select: { primaryAccount: true },
      });

      return row?.primaryAccount ?? null;
    });
  },

  linkVerifiedEmail(userId: string, email: string) {
    return prisma.authUser.update({
      where: { id: userId },
      data: {
        email,
        emailVerified: true,
      },
      select: {
        id: true,
        email: true,
        emailVerified: true,
      },
    });
  },

  findByIdForAdminIdentity(userId: string) {
    return prisma.authUser.findUnique({
      where: { id: userId },
      select: {
        email: true,
        emailVerified: true,
        passwordHash: true,
        linkedAccounts: {
          select: { provider: true, email: true, linkedAt: true },
          orderBy: { linkedAt: "asc" },
        },
      },
    });
  },

  setUnverifiedEmail(userId: string, email: string) {
    return prisma.authUser.update({
      where: { id: userId },
      data: { email, emailVerified: false },
      select: { id: true, email: true },
    });
  },

  findByEmailForPasswordReset(email: string) {
    return prisma.authUser.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        status: true,
        deletedAt: true,
        linkedAccounts: { select: { id: true }, take: 1 },
      },
    });
  },

  findPasswordHashByUserId(userId: string) {
    return prisma.authUser.findUnique({
      where: { id: userId },
      select: {
        passwordHash: true,
        status: true,
        deletedAt: true,
        linkedAccounts: { select: { id: true }, take: 1 },
      },
    });
  },

  updatePasswordHash(userId: string, passwordHash: string) {
    return prisma.authUser.update({
      where: { id: userId },
      data: {
        passwordHash,
        lastPasswordChangeAt: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
  },

  /**
   * `exceptSessionId` keeps the device that performed the change signed in —
   * a signed-in password change must not log the user out of the very screen
   * they are on. Password RESET passes nothing (there is no trusted session to
   * spare), so it still revokes everything.
   */
  revokeSessionsAfterPasswordChange(userId: string, exceptSessionId?: string) {
    const now = new Date();

    return prisma.$transaction(async (tx) => {
      await tx.session.updateMany({
        where: {
          userId,
          revokedAt: null,
          ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
        },
        data: {
          revokedAt: now,
          revokedReason: SessionRevokeReason.PASSWORD_CHANGED,
        },
      });

      // The surviving session's refresh token has to survive with it, or the
      // kept device dies at the next silent refresh instead of staying signed in.
      await tx.refreshToken.updateMany({
        where: {
          userId,
          revokedAt: null,
          ...(exceptSessionId ? { sessionId: { not: exceptSessionId } } : {}),
        },
        data: { revokedAt: now },
      });
    });
  },

  hardDeleteUser(userId: string) {
    return prisma.$transaction(async (tx) => {
      const activeSessions = await tx.session.findMany({
        where: { userId, revokedAt: null },
        select: { id: true },
      });

      await tx.authUser.delete({ where: { id: userId } });

      return {
        deletedAt: new Date(),
        revokedSessionIds: activeSessions.map((session) => session.id),
      };
    });
  },

  /**
   * SOFT DELETE ONLY — nothing here removes a row, by requirement. The account
   * is marked for deletion and every active session + refresh token is revoked
   * so neither password login nor any linked Google/Apple provider can
   * authenticate, but all data is retained and the whole operation is
   * reversible by clearing `deletedAt`/`deletionRequestedAt`/
   * `scheduledDeletionAt` and setting `status` back to ACTIVE.
   *
   * `scheduledDeletionAt` is recorded for the 30-day grace period, but NO job
   * currently reads it — auth-service's only scheduled job is the QR link
   * expiry sweeper. Nothing in this codebase hard-purges an AuthUser. If a
   * purge job is ever added, it becomes the one place that deletes rows; do not
   * reintroduce deletes here.
   */
  /**
   * Accounts whose grace period has elapsed and whose data has not yet been
   * erased. Ordered oldest-first so a backlog drains in the order it accrued.
   */
  findAccountsDueForPurge(now: Date, limit: number) {
    return prisma.authUser.findMany({
      where: {
        deletedAt: { not: null },
        scheduledDeletionAt: { lte: now },
        purgedAt: null,
      },
      select: { id: true, scheduledDeletionAt: true },
      orderBy: { scheduledDeletionAt: "asc" },
      take: limit,
    });
  },

  /**
   * Erase one account's personal data, in one transaction.
   *
   * The row survives — messages, memberships and audit records reference its id
   * — but every value that identifies a person is replaced. See
   * `lib/account-anonymize.ts` for what is replaced and why.
   *
   * Claim-then-write: the update is conditional on `purgedAt` still being null,
   * so two replicas running the sweeper at once cannot both purge the same
   * account and publish the event twice. The loser's update matches no row.
   */
  async purgeAccount(userId: string): Promise<boolean> {
    const claimed = await prisma.authUser.updateMany({
      where: { id: userId, purgedAt: null, deletedAt: { not: null } },
      data: { purgedAt: new Date() },
    });
    if (claimed.count === 0) return false;

    await prisma.$transaction(async (tx) => {
      await tx.authUser.update({
        where: { id: userId },
        data: anonymizedAccountFields(userId),
      });

      const links = await tx.linkedAccount.findMany({
        where: { userId },
        select: { id: true },
      });
      for (const link of links) {
        await tx.linkedAccount.update({
          where: { id: link.id },
          data: anonymizedLinkedAccountFields(userId, link.id),
        });
      }

      // One-time codes and reset tokens are credentials tied to an address that
      // no longer exists here. They are rows, not references — nothing points at
      // them — so they are deleted outright rather than blanked.
      await tx.otpCode.deleteMany({ where: { userId } });
      await tx.passwordResetToken.deleteMany({ where: { userId } });
    });

    return true;
  },

  softDeleteUser(userId: string) {
    return prisma.$transaction(async (tx) => {
      const now = new Date();
      const scheduledDeletionAt = new Date(
        now.getTime() + 30 * 24 * 60 * 60 * 1000
      );

      const activeSessions = await tx.session.findMany({
        where: { userId, revokedAt: null },
        select: { id: true },
      });

      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: {
          revokedAt: now,
          revokedReason: SessionRevokeReason.ACCOUNT_DELETED,
        },
      });

      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });

      // Google/Apple links are KEPT. This used to `deleteMany` them, which was
      // the one hard delete in an otherwise soft flow and made the 30-day grace
      // period a lie: restoring the account could not restore its social links,
      // because the rows were gone for good.
      //
      // Keeping them is safe. Social sign-in does not become possible again:
      // social-auth.service loads the user behind the LinkedAccount and rejects
      // on `deletedAt` and on `status !== ACTIVE` before issuing anything, so a
      // soft-deleted account fails there exactly like password login fails in
      // auth.service.
      //
      // The cost is that `@@unique([provider, providerUserId])` keeps that
      // provider `sub` reserved by this account, so the same Google/Apple
      // identity cannot be linked to a DIFFERENT account while this one is
      // soft-deleted. That is the price of a reversible delete; releasing the
      // `sub` belongs in a future purge job, not here.

      await tx.authUser.update({
        where: { id: userId },
        data: {
          status: AccountStatus.PENDING_DELETION,
          deletionRequestedAt: now,
          scheduledDeletionAt,
          deletedAt: now,
        },
      });

      return {
        deletedAt: now,
        revokedSessionIds: activeSessions.map((session) => session.id),
      };
    });
  },

  /**
   * Exact inverse of {@link softDeleteUser}: clears the three deletion markers
   * and puts the account back to ACTIVE.
   *
   * There is nothing else to undo. The soft delete removed no row — sessions and
   * refresh tokens were revoked in place (and stay revoked; the user signs in
   * fresh, exactly as after an unban) and the Google/Apple links were kept, so
   * password login AND every linked provider start working again the moment
   * these columns are cleared, via the same `deletedAt`/`status` guards that
   * were blocking them.
   *
   * Idempotent: restoring an account that is not deleted writes the same ACTIVE
   * row, so a retried admin request (or a redelivered event) cannot corrupt it.
   */
  restoreUser(userId: string) {
    return prisma.$transaction(async (tx) => {
      const now = new Date();

      await tx.authUser.update({
        where: { id: userId },
        data: {
          status: AccountStatus.ACTIVE,
          deletionRequestedAt: null,
          scheduledDeletionAt: null,
          deletedAt: null,
        },
      });

      return { restoredAt: now };
    });
  },

  /**
   * The account that owns `account` IGNORING CASE — "taken" semantics, used by
   * registration, availability and social account generation.
   *
   * Case-insensitive because "Rajesh_Sharma" and "rajesh_sharma" are one
   * identity: new handles are stored lowercase, but legacy ones keep the case
   * they were created with, so an exact match would let a newcomer claim
   * "rajesh_sharma" next to a legacy "Rajesh_Sharma". When several legacy rows
   * share a lowercase form (`accountCaseConflict`), the exact-case one wins,
   * else any of them — every caller only asks "is it taken?".
   */
  async findByAccount(account: string) {
    const [match] = await accountMatchesIgnoringCase(account);
    return match
      ? prisma.authUser.findUnique({ where: { id: match.id } })
      : null;
  },

  /**
   * Login resolves the exact-case handle first, then a case-insensitive one —
   * but only when it is unambiguous. Legacy rows that differ only by case
   * (`accountCaseConflict`) each still sign in with their own exact spelling;
   * a third spelling of theirs matches nobody rather than a guess.
   */
  async findByAccountForLogin(account: string) {
    const matches = await accountMatchesIgnoringCase(account);
    const match = matches[0]?.exact || matches.length === 1 ? matches[0] : null;
    return match
      ? prisma.authUser.findUnique({
          where: { id: match.id },
          select: loginUserSelect,
        })
      : null;
  },

  findByEmailForLogin(email: string) {
    return prisma.authUser.findUnique({
      where: { email },
      select: loginUserSelect,
    });
  },

  /**
   * Atomically increment failed-login attempts; once `maxAttempts` is reached,
   * lock the account for `lockoutMinutes`. Runs in a transaction so concurrent
   * bad-password attempts cannot race past the threshold.
   */
  recordFailedLogin(
    userId: string,
    maxAttempts: number,
    lockoutMinutes: number
  ) {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.authUser.update({
        where: { id: userId },
        data: { failedLoginAttempts: { increment: 1 } },
        select: { failedLoginAttempts: true },
      });

      if (updated.failedLoginAttempts >= maxAttempts) {
        await tx.authUser.update({
          where: { id: userId },
          data: {
            lockedUntil: new Date(Date.now() + lockoutMinutes * 60 * 1000),
          },
        });
      }
    });
  },

  async getProfileCompleted(userId: string): Promise<boolean> {
    const row = await prisma.authUser.findUnique({
      where: { id: userId },
      select: { isProfileCompleted: true },
    });
    return row?.isProfileCompleted ?? false;
  },

  findRoleByUserId(userId: string) {
    return prisma.authUser.findUnique({
      where: { id: userId },
      // `status` rides along so QR device-link can refuse to mint a brand-new
      // browser session for a banned account (one query, not two).
      select: { role: true, status: true },
    });
  },

  /**
   * Mirrors the profile-completion flag from the user.profile_updated event.
   * Uses updateMany so a stale event for a deleted/missing user is a no-op
   * rather than throwing.
   */
  async markProfileCompletion(userId: string, isProfileCompleted: boolean) {
    await prisma.authUser.updateMany({
      where: { id: userId },
      data: { isProfileCompleted },
    });
  },

  recordSuccessfulLogin(userId: string) {
    return prisma.authUser.update({
      where: { id: userId },
      data: {
        lastLoginAt: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
  },

  async mergeFcmTokens(userId: string, tokens: string[] | null): Promise<void> {
    if (!tokens || tokens.length === 0) return;
    await prisma.$executeRaw`
      UPDATE auth_users
      SET "fcmTokens" = (
        SELECT array_agg(DISTINCT t) FROM unnest("fcmTokens" || ${tokens}::text[]) AS t
      )
      WHERE id = ${userId}::uuid
    `;
  },

  createUser(data: Prisma.AuthUserCreateInput) {
    return prisma.authUser.create({
      data,
      select: {
        id: true,
        account: true,
        email: true,
        createdAt: true,
        role: true,
      },
    });
  },

  /**
   * Creates a social account and its provider link together.
   *
   * `email`/`emailVerified` are the PROFILE email — the address the user links
   * by hand — and social sign-in passes null/false for them: a Google or Apple
   * address belongs to `providerEmail` on the link row, never to the profile
   * field the Settings screen renders. They stay in the signature because the
   * column is real and a future flow may legitimately seed it.
   *
   * `primaryAccount` is stamped here rather than through
   * {@link setPrimaryAccountIfUnset} because the row is brand new: the provider
   * that created the account IS its first sign-in method, and writing it inside
   * the same transaction means no reader can ever see the account without one.
   */
  createUserWithLinkedAccount(params: {
    account: string;
    email: string | null;
    emailVerified: boolean;
    provider: AuthProvider;
    providerUserId: string;
    primaryAccount?: AuthProvider | null;
    displayName?: string | null;
    providerEmail?: string | null;
    providerEmailVerified?: boolean;
  }) {
    return prisma.$transaction(async (tx) => {
      const user = await tx.authUser.create({
        data: {
          account: params.account,
          email: params.email,
          emailVerified: params.emailVerified,
          primaryAccount: params.primaryAccount ?? undefined,
          passwordHash: null,
        },
        select: {
          id: true,
          account: true,
          email: true,
          primaryAccount: true,
          createdAt: true,
        },
      });

      await tx.linkedAccount.create({
        data: {
          userId: user.id,
          provider: params.provider,
          providerUserId: params.providerUserId,
          email: params.providerEmail ?? params.email ?? undefined,
          emailVerified: params.providerEmailVerified ?? false,
          displayName: params.displayName ?? undefined,
        },
      });

      return user;
    });
  },

  createSessionWithRefreshToken(params: {
    userId: string;
    deviceId: string;
    deviceType: DeviceType;
    deviceName?: string | null;
    osVersion?: string | null;
    appVersion?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    countryCode?: string | null;
    refreshTokenHash: string;
    refreshExpiresAt: Date;
  }) {
    return prisma.$transaction(async (tx) => {
      const session = await tx.session.create({
        data: {
          userId: params.userId,
          deviceId: params.deviceId,
          deviceType: params.deviceType,
          deviceName: params.deviceName ?? undefined,
          osVersion: params.osVersion ?? undefined,
          appVersion: params.appVersion ?? undefined,
          ipAddress: params.ipAddress ?? undefined,
          userAgent: params.userAgent ?? undefined,
          countryCode: params.countryCode ?? undefined,
        },
        // Full session-list projection so callers (issueAuthTokens) can emit the
        // persisted row via the shared serializer without a second query.
        select: {
          id: true,
          deviceId: true,
          deviceName: true,
          deviceType: true,
          osVersion: true,
          appVersion: true,
          ipAddress: true,
          countryCode: true,
          lastActiveAt: true,
          createdAt: true,
        },
      });

      await tx.refreshToken.create({
        data: {
          userId: params.userId,
          sessionId: session.id,
          tokenHash: params.refreshTokenHash,
          expiresAt: params.refreshExpiresAt,
        },
      });

      return session;
    });
  },
};
