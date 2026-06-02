import { UnauthorizedError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import type {
  AccountLoadStatus,
  AuthAccountSummary,
} from "../types/auth-account.types.js";
import { fetchAuthAccountSummary } from "./auth-client.js";

export type ResolvedAuthAccount = {
  account: AuthAccountSummary | null;
  accountStatus: AccountLoadStatus;
};

/**
 * Loads sign-in provider data live from auth-service on every call.
 * On auth outage: omits account data without failing the request.
 */
export async function resolveAuthAccountSummary(
  userId: string,
  accessToken: string
): Promise<ResolvedAuthAccount> {
  try {
    const summary = await fetchAuthAccountSummary(accessToken);
    return { account: summary, accountStatus: "live" };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }

    logger.warn(
      `Auth service unavailable for userId=${userId}; connected accounts returned without providers`
    );
    return { account: null, accountStatus: "unavailable" };
  }
}
