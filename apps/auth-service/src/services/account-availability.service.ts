import { UnauthorizedError } from "@aimess/errors";

import { assertNotBanned } from "../lib/account-guard.js";
import {
  isEmailLoginIdentifier,
  normalizeLoginIdentifier,
} from "../lib/login-identifier.js";
import { accountLockedError, lockedForSec } from "../lib/login-lockout.js";
import { passwordUnavailableCode } from "../lib/sign-in-methods.js";
import { AccountStatus } from "../generated/prisma/client.js";
import { authRepository } from "../repositories/auth.repository.js";

export const accountAvailabilityService = {
  /**
   * Answers "is this handle free?" for the signup form, and — because the login
   * form's step 1 asks the same question inverted — "does this account exist?"
   * for login.
   *
   * It resolves the identifier the same way login does: an email-shaped value is
   * looked up against the profile email, anything else against the account name.
   * Without that split, an account whose owner signs in with their linked email
   * was reported as available, which sent them to the signup form instead of the
   * password step.
   *
   * The lookup deliberately does NOT require the email to be verified. An
   * address that exists is taken either way — the register path cannot claim it,
   * and login has its own verification guard that answers with credentials, not
   * with account existence.
   *
   * `purpose: "login"` (login step 1) resolves the account state here, before
   * the password step, with the same status + code login returns for it:
   * deleted, locked, banned, inactive, or which provider to use when the
   * account has no password. Unverified email keeps the plain "exists" answer.
   *
   * Enumeration: product decision 2026-10-12 (AIMESS-62) — account state is
   * disclosed at the identifier step; the rate limiter is the only guard.
   */
  async validateAvailability(
    account: string,
    purpose?: "login"
  ): Promise<{
    account: string;
    available: boolean;
    passwordUnavailableCode?: ReturnType<typeof passwordUnavailableCode>;
  }> {
    const normalized = normalizeLoginIdentifier(account);
    const isEmail = isEmailLoginIdentifier(normalized);
    const existing = isEmail
      ? await authRepository.findByEmail(normalized)
      : await authRepository.findByAccount(normalized);

    if (!existing) return { account: normalized, available: true };
    if (purpose !== "login") return { account: normalized, available: false };

    // The same resolution login uses, so "which account" is answered once.
    const user = isEmail
      ? await authRepository.findByEmailForLogin(normalized)
      : await authRepository.findByAccountForLogin(normalized);
    if (!user) return { account: normalized, available: false };
    if (
      user.deletedAt ||
      user.status === AccountStatus.PENDING_DELETION ||
      user.status === AccountStatus.DELETED
    ) {
      throw new UnauthorizedError("AUTH_ACCOUNT_DELETED");
    }
    if (isEmail && !user.emailVerified) {
      return { account: normalized, available: false };
    }
    if (lockedForSec(user.lockedUntil) > 0) {
      throw accountLockedError(lockedForSec(user.lockedUntil));
    }
    assertNotBanned(user.status);
    if (user.status !== AccountStatus.ACTIVE) {
      throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
    }

    return {
      account: normalized,
      available: false,
      ...(!user.passwordHash
        ? { passwordUnavailableCode: passwordUnavailableCode(user) }
        : {}),
    };
  },
};
