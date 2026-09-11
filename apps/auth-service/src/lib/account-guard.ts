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

// A soft-deleted account gets its own code, for the same reason a ban does.
//
// Every entry point used to fold `deletedAt` into the generic
// UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE") below, whose copy reads "Your
// account has been disabled. Please contact support." — which tells a user who
// deleted their own account that something was done TO them, and points them at
// a support queue that cannot help. Deleted and disabled are different states
// and now answer differently.
//
// Call BEFORE the generic status check: a soft delete also sets status to
// PENDING_DELETION, so a deleted account falls into that branch otherwise.
//
// Only ever called where the caller has already proven a credential (a session,
// a refresh token, a signed provider token, or a verified password). Password
// login gates it behind the bcrypt compare for exactly this reason — see
// auth.service.login.
export function assertNotDeleted(deletedAt: Date | null): void {
  if (deletedAt) {
    throw new UnauthorizedError("AUTH_ACCOUNT_DELETED");
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

  if (!user) {
    throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
  }

  assertNotDeleted(user.deletedAt);
  assertNotBanned(user.status);

  if (user.status !== AccountStatus.ACTIVE) {
    throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
  }

  return user;
}
