import { ForbiddenError, UnauthorizedError } from "@aimess/errors";

import { AccountStatus } from "../generated/prisma/client.js";
import { authRepository } from "../repositories/auth.repository.js";
import { accountBanService } from "../services/account-ban.service.js";

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

// 403 carrying the restriction's reason (and a suspension's end, epoch ms) for the sign-in screen.
export class AccountRestrictedError extends ForbiddenError {
  constructor(
    code: "ACCOUNT_BANNED" | "ACCOUNT_SUSPENDED",
    readonly reason: string | null = null,
    readonly until: number | null = null
  ) {
    super(code);
  }
}

type Restrictable = {
  id: string;
  status: AccountStatus;
  suspendedReason: string | null;
  suspendedUntil: Date | null;
};

// Throws for a ban or a live suspension; lifts an elapsed suspension and returns the new status.
// `disclose` gates reason/until behind a proven credential.
export async function assertNotRestricted(
  user: Restrictable,
  disclose: boolean
): Promise<AccountStatus> {
  if (user.status === AccountStatus.BANNED) {
    throw new AccountRestrictedError(
      "ACCOUNT_BANNED",
      disclose ? user.suspendedReason : null
    );
  }
  if (user.status !== AccountStatus.SUSPENDED) return user.status;
  const until = user.suspendedUntil?.getTime() ?? null;
  if (until !== null && until <= Date.now()) {
    await accountBanService.liftExpiredSuspension(user.id);
    return AccountStatus.ACTIVE;
  }
  throw new AccountRestrictedError(
    "ACCOUNT_SUSPENDED",
    disclose ? user.suspendedReason : null,
    disclose ? until : null
  );
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

  if ((await assertNotRestricted(user, true)) !== AccountStatus.ACTIVE) {
    throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
  }

  return user;
}
