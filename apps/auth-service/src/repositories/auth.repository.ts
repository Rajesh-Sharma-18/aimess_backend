import { prisma } from "../config/prisma.js";
import {
  AccountStatus,
  AuthProvider,
  SessionRevokeReason,
  type DeviceType,
  type Prisma,
} from "../generated/prisma/client.js";

const loginUserSelect = {
  id: true,
  account: true,
  email: true,
  emailVerified: true,
  passwordHash: true,
  status: true,
  lockedUntil: true,
  deletedAt: true,
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

  findByEmailForPasswordReset(email: string) {
    return prisma.authUser.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        status: true,
        deletedAt: true,
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

  revokeSessionsAfterPasswordChange(userId: string) {
    const now = new Date();

    return prisma.$transaction(async (tx) => {
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: {
          revokedAt: now,
          revokedReason: SessionRevokeReason.PASSWORD_CHANGED,
        },
      });

      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
    });
  },

  /**
   * Soft-delete the account: tombstone the user, revoke every active session
   * (reason ACCOUNT_DELETED) and revoke outstanding refresh tokens — all in one
   * transaction. Returns the revoked session ids so the caller can flush the
   * Redis active-session cache.
   */
  softDeleteUser(userId: string) {
    return prisma.$transaction(async (tx) => {
      const now = new Date();

      const activeSessions = await tx.session.findMany({
        where: { userId, revokedAt: null },
        select: { id: true },
      });

      await tx.authUser.update({
        where: { id: userId },
        data: {
          status: AccountStatus.DELETED,
          deletedAt: now,
          deletionRequestedAt: now,
        },
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

      return {
        deletedAt: now,
        revokedSessionIds: activeSessions.map((session) => session.id),
      };
    });
  },

  findByAccount(account: string) {
    return prisma.authUser.findUnique({ where: { account } });
  },

  findByAccountForLogin(account: string) {
    return prisma.authUser.findUnique({
      where: { account },
      select: loginUserSelect,
    });
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

  /**
   * Merge new FCM tokens into the user's existing set (union + dedupe) so
   * multiple devices accumulate without duplicates and without overwriting
   * tokens registered by other devices.
   */
  async mergeFcmTokens(userId: string, tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;

    const current = await prisma.authUser.findUnique({
      where: { id: userId },
      select: { fcmTokens: true },
    });

    const merged = Array.from(
      new Set([...(current?.fcmTokens ?? []), ...tokens])
    );

    await prisma.authUser.update({
      where: { id: userId },
      data: { fcmTokens: merged },
    });
  },

  createUser(data: Prisma.AuthUserCreateInput) {
    return prisma.authUser.create({
      data,
      select: {
        id: true,
        account: true,
        email: true,
        createdAt: true,
      },
    });
  },

  createUserWithLinkedAccount(params: {
    account: string;
    email: string | null;
    emailVerified: boolean;
    provider: AuthProvider;
    providerUserId: string;
    displayName?: string | null;
    providerEmail?: string | null;
    fcmTokens?: string[];
  }) {
    return prisma.$transaction(async (tx) => {
      const user = await tx.authUser.create({
        data: {
          account: params.account,
          email: params.email,
          emailVerified: params.emailVerified,
          passwordHash: null,
          fcmTokens: params.fcmTokens ?? [],
        },
        select: {
          id: true,
          account: true,
          email: true,
          createdAt: true,
        },
      });

      await tx.linkedAccount.create({
        data: {
          userId: user.id,
          provider: params.provider,
          providerUserId: params.providerUserId,
          email: params.providerEmail ?? params.email ?? undefined,
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
    refreshTokenHash: string;
    refreshExpiresAt: Date;
  }) {
    return prisma.$transaction(async (tx) => {
      await tx.session.deleteMany({
        where: {
          userId: params.userId,
          deviceId: params.deviceId,
        },
      });

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
        },
        select: { id: true },
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
