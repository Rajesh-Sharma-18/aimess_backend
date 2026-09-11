import {
  isEmailLoginIdentifier,
  normalizeLoginIdentifier,
} from "../lib/login-identifier.js";
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
   */
  async validateAvailability(
    account: string
  ): Promise<{ account: string; available: boolean }> {
    const normalized = normalizeLoginIdentifier(account);
    const existing = isEmailLoginIdentifier(normalized)
      ? await authRepository.findByEmail(normalized)
      : await authRepository.findByAccount(normalized);

    return {
      account: normalized,
      available: !existing,
    };
  },
};
