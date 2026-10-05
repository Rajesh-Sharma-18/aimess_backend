import {
  isEmailLoginIdentifier,
  normalizeLoginIdentifier,
} from "../lib/login-identifier.js";
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
   * `purpose: "login"` (login step 1) additionally reports when the account
   * cannot use a password at all, so the client sends the user to Google/Apple
   * instead of a password field that can never succeed. It is decided by the
   * credential the account has NOW (`passwordHash`), never by how it was
   * founded, and only for an account that would reach that same branch of
   * login: deleted, unverified-email, locked, banned or otherwise inactive
   * accounts keep the plain "exists" answer, so login's own precedence
   * (banned before "use Google", etc.) is what the user sees, unchanged.
   *
   * Enumeration: login already returns exactly these codes for any password
   * sent to such an account, so this moves the same answer one step earlier
   * rather than revealing anything new. Only a code is returned — no provider
   * id, email, or credential detail.
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
    const reachesPasswordCheck =
      user &&
      !user.deletedAt &&
      (!isEmail || user.emailVerified) &&
      !(user.lockedUntil && user.lockedUntil > new Date()) &&
      user.status === AccountStatus.ACTIVE;

    return {
      account: normalized,
      available: false,
      ...(reachesPasswordCheck && !user.passwordHash
        ? { passwordUnavailableCode: passwordUnavailableCode(user) }
        : {}),
    };
  },
};
