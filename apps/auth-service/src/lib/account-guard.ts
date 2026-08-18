import { ForbiddenError, UnauthorizedError } from "@aimess/errors";

import { AccountStatus } from "../generated/prisma/client.js";
import { authRepository } from "../repositories/auth.repository.js";

// A permanent Super Admin ban gets its own status + code on every entry point.
//
// Every one of those paths already refused a non-ACTIVE account with
// UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE") — a 401 whose copy reads
// "Your account has been disabled", which clients correctly treat as
// "re-authenticate". That is exactly the wrong instruction for a ban: no
// credential, refresh, or reset will ever work again. 403 + ACCOUNT_BANNED
// lets Web/Android/iOS stop retrying and show the real reason.
//
// Call BEFORE the generic status check so BANNED never falls through to it.
export function assertNotBanned(status: AccountStatus): void {
  if (status === AccountStatus.BANNED) {
    throw new ForbiddenError("ACCOUNT_BANNED");
  }
}

export type ActiveAuthUser = {
  id: string;
  email: string | null;
  emailVerified: boolean;
  passwordHash: string | null;
  status: AccountStatus;
  deletedAt: Date | null;
};

export async function loadActiveAuthUser(
  userId: string
): Promise<ActiveAuthUser> {
  const user = await authRepository.findByIdForAccountOps(userId);

  if (!user || user.deletedAt) {
    throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
  }

  assertNotBanned(user.status);

  if (user.status !== AccountStatus.ACTIVE) {
    throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
  }

  return user;
}
