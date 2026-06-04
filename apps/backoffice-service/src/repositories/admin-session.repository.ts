import { prisma } from "../config/prisma.js";

export const adminSessionRepository = {
  create(input: {
    adminId: string;
    refreshTokenHash: string;
    refreshExpiresAt: Date;
    ip: string;
    userAgent?: string | null;
  }) {
    return prisma.adminSession.create({
      data: {
        adminId: input.adminId,
        refreshTokenHash: input.refreshTokenHash,
        refreshExpiresAt: input.refreshExpiresAt,
        ip: input.ip,
        userAgent: input.userAgent ?? null,
      },
      select: { id: true },
    });
  },

  /** Used by the active-session cache fallback to validate a session row. */
  findActiveById(sessionId: string) {
    return prisma.adminSession.findUnique({
      where: { id: sessionId },
      select: { id: true, revokedAt: true, refreshExpiresAt: true },
    });
  },

  findByRefreshTokenHash(hash: string) {
    return prisma.adminSession.findUnique({
      where: { refreshTokenHash: hash },
      select: {
        id: true,
        adminId: true,
        revokedAt: true,
        refreshExpiresAt: true,
        rotatedToId: true,
      },
    });
  },

  /**
   * Rotate a refresh token. Atomically claims the old row first (conditional on
   * it still being active and un-rotated) so two concurrent refreshes using the
   * same token can't both succeed, then creates the successor row and links them
   * (`rotatedToId`) for reuse detection. Returns null when the old row was
   * already rotated/revoked by a concurrent request — caller treats as invalid.
   */
  async rotate(input: {
    oldSessionId: string;
    adminId: string;
    newRefreshTokenHash: string;
    newRefreshExpiresAt: Date;
    ip: string;
    userAgent?: string | null;
  }): Promise<{ id: string } | null> {
    return prisma.$transaction(async (tx) => {
      const claimed = await tx.adminSession.updateMany({
        where: { id: input.oldSessionId, revokedAt: null, rotatedToId: null },
        data: { revokedAt: new Date() },
      });
      if (claimed.count === 0) {
        // Already rotated/revoked by a concurrent request.
        return null;
      }
      const newRow = await tx.adminSession.create({
        data: {
          adminId: input.adminId,
          refreshTokenHash: input.newRefreshTokenHash,
          refreshExpiresAt: input.newRefreshExpiresAt,
          ip: input.ip,
          userAgent: input.userAgent ?? null,
        },
        select: { id: true },
      });
      await tx.adminSession.update({
        where: { id: input.oldSessionId },
        data: { rotatedToId: newRow.id },
      });
      return { id: newRow.id };
    });
  },

  /** Idempotent revoke by session id — no-op if already revoked/missing. */
  revoke(sessionId: string) {
    return prisma.adminSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  /** Active (non-revoked, unexpired) session ids for forced revocation. */
  listActiveByAdmin(adminId: string) {
    return prisma.adminSession.findMany({
      where: {
        adminId,
        revokedAt: null,
        refreshExpiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
  },

  /** Revoke every still-active session for an admin (e.g. after password reset). */
  revokeAllForAdmin(adminId: string) {
    return prisma.adminSession.updateMany({
      where: { adminId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },
};
