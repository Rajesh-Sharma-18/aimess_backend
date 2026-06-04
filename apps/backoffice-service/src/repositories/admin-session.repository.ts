import { prisma } from "../config/prisma.js";

export const adminSessionRepository = {
  create(input: {
    adminId: string;
    jti: string;
    ip: string;
    userAgent?: string | null;
    expiresAt: Date;
  }) {
    return prisma.adminSession.create({
      data: {
        adminId: input.adminId,
        jti: input.jti,
        ip: input.ip,
        userAgent: input.userAgent ?? null,
        expiresAt: input.expiresAt,
      },
    });
  },

  findByJti(jti: string) {
    return prisma.adminSession.findUnique({ where: { jti } });
  },

  /** Idempotent revoke by jti — no-op if the row is already revoked/missing. */
  revoke(jti: string) {
    return prisma.adminSession.updateMany({
      where: { jti, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  /** Active (non-revoked, unexpired) session jtis for forced revocation. */
  listActiveByAdmin(adminId: string) {
    return prisma.adminSession.findMany({
      where: {
        adminId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { jti: true, expiresAt: true },
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
