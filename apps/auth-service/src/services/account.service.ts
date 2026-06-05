import { NotFoundError } from "@aimess/errors";

import { AuthProvider } from "../generated/prisma/client.js";
import { loadActiveAuthUser } from "../lib/account-guard.js";
import type {
  AccountSummaryResponse,
  ConnectedProviderInfo,
  SignInProvider,
} from "../types/account.types.js";
import { authRepository } from "../repositories/auth.repository.js";

const ALL_PROVIDERS: SignInProvider[] = ["EMAIL", "GOOGLE", "APPLE"];

type LinkedAccountRow = {
  provider: AuthProvider;
  providerUserId: string;
  email: string | null;
  linkedAt: Date;
};

function buildProvidersList(
  primaryEmail: string | null,
  emailConnected: boolean,
  linkedAccounts: LinkedAccountRow[]
): ConnectedProviderInfo[] {
  const socialByProvider = new Map<
    typeof AuthProvider.GOOGLE | typeof AuthProvider.APPLE,
    LinkedAccountRow
  >();

  for (const row of linkedAccounts) {
    if (
      row.provider === AuthProvider.GOOGLE ||
      row.provider === AuthProvider.APPLE
    ) {
      socialByProvider.set(row.provider, row);
    }
  }

  return ALL_PROVIDERS.map((provider) => {
    if (provider === "EMAIL") {
      return {
        provider,
        connected: emailConnected,
        providerUserId: emailConnected ? primaryEmail : null,
        providerEmail: emailConnected ? primaryEmail : null,
        linkedAt: null,
      };
    }

    const authProvider =
      provider === "GOOGLE" ? AuthProvider.GOOGLE : AuthProvider.APPLE;
    const link = socialByProvider.get(authProvider);

    return {
      provider,
      connected: link != null,
      providerUserId: link?.providerUserId ?? null,
      providerEmail: link?.email ?? null,
      linkedAt: link?.linkedAt.toISOString() ?? null,
    };
  });
}

export const accountService = {
  async getAccountSummary(userId: string): Promise<AccountSummaryResponse> {
    const user = await loadActiveAuthUser(userId);
    const summary = await authRepository.findAccountSummaryByUserId(userId);

    if (!summary) {
      throw new NotFoundError("AUTH_ACCOUNT_NOT_ACTIVE");
    }

    const emailConnected = Boolean(summary.email && summary.emailVerified);

    return {
      userId: summary.id,
      account: summary.account,
      email: summary.email,
      emailVerified: summary.emailVerified,
      hasPassword: Boolean(user.passwordHash),
      primaryAccount: summary.primaryAccount ?? null,
      providers: buildProvidersList(
        summary.email,
        emailConnected,
        summary.linkedAccounts
      ),
    };
  },
};
