import { prisma } from "../config/prisma.js";

export const adminPasswordResetTokenRepository = {
  consumeActiveForAdmin(adminId: string) {
    return prisma.adminPasswordResetToken.updateMany({
      where: {
        adminId,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });
  },

  create(params: { adminId: string; tokenHash: string; expiresAt: Date }) {
    return prisma.adminPasswordResetToken.create({
      data: params,
    });
  },

  findValidByTokenHash(tokenHash: string) {
    return prisma.adminPasswordResetToken.findUnique({
      where: { tokenHash },
      include: {
        admin: {
          select: {
            id: true,
            status: true,
            passwordHash: true,
          },
        },
      },
    });
  },

  markConsumed(id: string) {
    return prisma.adminPasswordResetToken.update({
      where: { id },
      data: { consumedAt: new Date() },
    });
  },
};
