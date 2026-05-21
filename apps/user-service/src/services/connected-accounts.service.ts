import { resolveAuthAccountSummary } from "../lib/resolve-auth-account.js";
import type { ConnectedAccountsResponse } from "../types/connected-accounts.types.js";

export const connectedAccountsService = {
  async getConnectedAccounts(
    userId: string,
    accessToken: string
  ): Promise<ConnectedAccountsResponse> {
    const { account, accountStatus } = await resolveAuthAccountSummary(
      userId,
      accessToken
    );

    return {
      providers: account?.providers ?? null,
      accountStatus,
    };
  },
};
