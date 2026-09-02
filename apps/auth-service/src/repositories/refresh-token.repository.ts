import { prisma } from "../config/prisma.js";

export const refreshTokenRepository = {
  findByTokenHash(tokenHash: string) {
    return prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        sessionId: true,
        expiresAt: true,
        revokedAt: true,
        rotatedToId: true,
        // Rotation reuses the original lifetime, so it has to know it.
        createdAt: true,
        session: {
          select: {
            id: true,
            revokedAt: true,
          },
        },
        user: {
          select: {
            id: true,
            status: true,
            deletedAt: true,
            role: true,
          },
        },
      },
    });
  },

  rotate(params: {
    oldTokenId: string;
    userId: string;
    sessionId: string;
    newTokenHash: string;
    newExpiresAt: Date;
  }) {
    const now = new Date();

    return prisma.$transaction(async (tx) => {
      const newToken = await tx.refreshToken.create({
        data: {
          userId: params.userId,
          sessionId: params.sessionId,
          tokenHash: params.newTokenHash,
          expiresAt: params.newExpiresAt,
        },
        select: { id: true },
      });

      await tx.refreshToken.update({
        where: { id: params.oldTokenId },
        data: {
          revokedAt: now,
          rotatedToId: newToken.id,
        },
      });

      await tx.session.update({
        where: { id: params.sessionId },
        data: { lastActiveAt: now },
      });

      return newToken;
    });
  },
};
