import { UnauthorizedError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import type {
  AccountLoadStatus,
  AuthAccountSummary,
} from "../types/auth-account.types.js";
import { fetchAuthAccountSummary } from "./auth-client.js";
import { userCache } from "./user-cache.js";

export type ResolvedAuthAccount = {
  account: AuthAccountSummary | null;
  accountStatus: AccountLoadStatus;
};

/**
 * Loads sign-in provider data from auth-service when possible.
 * On auth outage: serves a recent Redis copy, or omits account without failing the request.
 */
export async function resolveAuthAccountSummary(
  userId: string,
  accessToken: string
): Promise<ResolvedAuthAccount> {
  // Cache-first: serve a recent Redis copy and skip the auth-service hop.
  const cachedSummary = await userCache.getAccountSummary(userId);
  if (cachedSummary) {
    return { account: cachedSummary, accountStatus: "cached" };
  }

  try {
    const summary = await fetchAuthAccountSummary(accessToken);
    await userCache.setAccountSummary(userId, summary);

    return { account: summary, accountStatus: "live" };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }

    const cached = await userCache.getAccountSummary(userId);
    if (cached) {
      logger.warn(
        "Auth service unavailable; serving cached account summary for connected accounts"
      );
      return { account: cached, accountStatus: "cached" };
    }

    logger.warn(
      "Auth service unavailable; connected accounts returned without providers"
    );
    return { account: null, accountStatus: "unavailable" };
  }
}
