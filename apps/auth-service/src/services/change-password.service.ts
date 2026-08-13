import bcrypt from "bcryptjs";

import { BadRequestError } from "@aimess/errors";

import type { ChangePasswordInput } from "../api/validators/change-password.validator.js";
import { loadActiveAuthUser } from "../lib/account-guard.js";
import { revokeSessionsForPasswordChange } from "../lib/revoke-password-sessions.js";
import { publishPasswordChangedSafe } from "../messaging/publish-auth-security.js";
import { authRepository } from "../repositories/auth.repository.js";

export const changePasswordService = {
  /**
   * `currentSessionId` is spared the revoke: a signed-in password change keeps
   * the device that made it, and signs every OTHER device out — the behaviour
   * a stolen-session victim expects. Password RESET revokes everything instead
   * (see password-reset.service), because there no session is trusted.
   */
  async change(
    userId: string,
    input: ChangePasswordInput,
    currentSessionId?: string
  ): Promise<void> {
    const user = await loadActiveAuthUser(userId);

    if (!user.passwordHash) {
      throw new BadRequestError("AUTH_PASSWORD_NOT_SET");
    }

    const currentValid = await bcrypt.compare(
      input.currentPassword,
      user.passwordHash
    );
    if (!currentValid) {
      throw new BadRequestError("AUTH_CURRENT_PASSWORD_INVALID");
    }

    const sameAsNew = await bcrypt.compare(
      input.newPassword,
      user.passwordHash
    );
    if (sameAsNew) {
      throw new BadRequestError("AUTH_PASSWORD_SAME_AS_CURRENT");
    }

    const passwordHash = await bcrypt.hash(input.newPassword, 12);

    await authRepository.updatePasswordHash(userId, passwordHash);

    // DB revoke + Redis cache bust + push-token teardown + socket kick.
    await revokeSessionsForPasswordChange(userId, currentSessionId);

    publishPasswordChangedSafe({ userId, at: new Date().toISOString() });
  },
};
