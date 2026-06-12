import { prisma } from "../config/prisma.js";
import { AuthProvider } from "../generated/prisma/client.js";

export const linkedAccountRepository = {
  findByProvider(provider: AuthProvider, providerUserId: string) {
    return prisma.linkedAccount.findUnique({
      where: {
        provider_providerUserId: { provider, providerUserId },
      },
      include: {
        user: {
          select: {
            id: true,
            account: true,
            email: true,
            status: true,
            lockedUntil: true,
            deletedAt: true,
            role: true,
          },
        },
      },
    });
  },

  findByUserIdAndProvider(userId: string, provider: AuthProvider) {
    return prisma.linkedAccount.findUnique({
      where: {
        userId_provider: { userId, provider },
      },
    });
  },

  countByUserId(userId: string) {
    return prisma.linkedAccount.count({ where: { userId } });
  },

  create(params: {
    userId: string;
    provider: AuthProvider;
    providerUserId: string;
    email?: string | null;
    displayName?: string | null;
  }) {
    return prisma.linkedAccount.create({
      data: {
        userId: params.userId,
        provider: params.provider,
        providerUserId: params.providerUserId,
        email: params.email ?? undefined,
        displayName: params.displayName ?? undefined,
      },
    });
  },

  deleteByUserIdAndProvider(userId: string, provider: AuthProvider) {
    return prisma.linkedAccount.delete({
      where: {
        userId_provider: { userId, provider },
      },
    });
  },
};
