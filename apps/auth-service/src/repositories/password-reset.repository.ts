import { prisma } from "../config/prisma.js";

export const passwordResetRepository = {
  consumeActiveForUser(userId: string) {
    return prisma.passwordResetToken.updateMany({
      where: {
        userId,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });
  },

  create(params: { userId: string; tokenHash: string; expiresAt: Date }) {
    return prisma.passwordResetToken.create({
      data: params,
    });
  },

  findValidByTokenHash(tokenHash: string) {
    return prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: {
        user: {
          select: {
            id: true,
            status: true,
            deletedAt: true,
            passwordHash: true,
          },
        },
      },
    });
  },

  markConsumed(id: string) {
    return prisma.passwordResetToken.update({
      where: { id },
      data: { consumedAt: new Date() },
    });
  },
};
