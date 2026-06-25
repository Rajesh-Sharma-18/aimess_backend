import { prisma } from "../config/prisma.js";
import { SessionRevokeReason } from "../generated/prisma/client.js";

const activeSessionSelect = {
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
} as const;

export const sessionRepository = {
  listActiveByUserId(userId: string) {
    return prisma.session.findMany({
      where: { userId, revokedAt: null },
      select: activeSessionSelect,
      orderBy: { lastActiveAt: "desc" },
    });
  },

  findActiveForUser(userId: string, sessionId: string) {
    return prisma.session.findFirst({
      where: { id: sessionId, userId, revokedAt: null },
      select: { id: true },
    });
  },

  isSessionActive(sessionId: string) {
    return prisma.session.findFirst({
      where: { id: sessionId, revokedAt: null },
      select: { id: true },
    });
  },

  listActiveSessionIds(userId: string) {
    return prisma.session.findMany({
      where: { userId, revokedAt: null },
      select: { id: true },
    });
  },

  touch(sessionId: string) {
    return prisma.session.update({
      where: { id: sessionId },
      data: { lastActiveAt: new Date() },
    });
  },

  revokeForUser(
    userId: string,
    sessionId: string,
    reason: SessionRevokeReason
  ) {
    const now = new Date();

    return prisma.$transaction(async (tx) => {
      const session = await tx.session.updateMany({
        where: {
          id: sessionId,
          userId,
          revokedAt: null,
        },
        data: {
          revokedAt: now,
          revokedReason: reason,
        },
      });

      if (session.count === 0) {
        return { revoked: false };
      }

      await tx.refreshToken.updateMany({
        where: { sessionId, revokedAt: null },
        data: { revokedAt: now },
      });

      return { revoked: true };
    });
  },

  revokeAllForUser(userId: string, reason: SessionRevokeReason) {
    const now = new Date();

    return prisma.$transaction(async (tx) => {
      const sessions = await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: {
          revokedAt: now,
          revokedReason: reason,
        },
      });

      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });

      return { revokedCount: sessions.count };
    });
  },

  /** Return the deviceId for a session that belongs to the given user, or null if not found. */
  getDeviceId(sessionId: string, userId: string): Promise<string | null> {
    return prisma.session
      .findFirst({
        where: { id: sessionId, userId },
        select: { deviceId: true },
      })
      .then((row) => row?.deviceId ?? null);
  },

  /** Revoke every active session EXCEPT the caller's current one ("sign out all other devices"). */
  revokeOthersForUser(
    userId: string,
    exceptSessionId: string,
    reason: SessionRevokeReason
  ) {
    const now = new Date();

    return prisma.$transaction(async (tx) => {
      const sessions = await tx.session.updateMany({
        where: { userId, revokedAt: null, id: { not: exceptSessionId } },
        data: {
          revokedAt: now,
          revokedReason: reason,
        },
      });

      await tx.refreshToken.updateMany({
        where: {
          userId,
          revokedAt: null,
          sessionId: { not: exceptSessionId },
        },
        data: { revokedAt: now },
      });

      return { revokedCount: sessions.count };
    });
  },
};
