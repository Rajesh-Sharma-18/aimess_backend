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

  /**
   * The account that already owns a PROVIDER-VERIFIED address.
   *
   * This is the only lookup allowed to merge an incoming social sign-in into an
   * existing account by email, so it is deliberately narrow: `emailVerified`
   * means the provider asserted the address in its signed token, never that a
   * client sent it. Without that filter the manual Apple-link path — which
   * accepts `input.email` from the request body — would be an account-takeover
   * vector, since anyone could link Apple with a victim’s address and then
   * capture the victim’s next Google sign-in.
   *
   * Ordered oldest-first so that if two links somehow carry the same address,
   * the account that claimed it first wins rather than the query planner.
   */
  findUserByVerifiedProviderEmail(email: string) {
    return prisma.linkedAccount.findFirst({
      where: { email, emailVerified: true },
      orderBy: { linkedAt: "asc" },
      select: {
        user: {
          select: {
            id: true,
            account: true,
            email: true,
            status: true,
            lockedUntil: true,
            deletedAt: true,
            role: true,
            isProfileCompleted: true,
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

  /**
   * `emailVerified` defaults to false so a caller that cannot prove the address
   * came from a signed provider token stores it display-only. See
   * {@link findUserByVerifiedProviderEmail} for why that distinction matters.
   */
  create(params: {
    userId: string;
    provider: AuthProvider;
    providerUserId: string;
    email?: string | null;
    emailVerified?: boolean;
    displayName?: string | null;
  }) {
    return prisma.linkedAccount.create({
      data: {
        userId: params.userId,
        provider: params.provider,
        providerUserId: params.providerUserId,
        email: params.email ?? undefined,
        emailVerified: params.emailVerified ?? false,
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
