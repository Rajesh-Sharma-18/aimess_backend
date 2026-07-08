import bcrypt from "bcryptjs";

import { BadRequestError, UnauthorizedError } from "@aimess/errors";

import type { ChangePasswordInput } from "../api/validators/change-password.validator.js";
import { loadActiveAuthUser } from "../lib/account-guard.js";
import { markSessionsRevoked } from "../lib/session-active-cache.js";
import { publishPasswordChangedSafe } from "../messaging/publish-auth-security.js";
import { authRepository } from "../repositories/auth.repository.js";
import { sessionRepository } from "../repositories/session.repository.js";

export const changePasswordService = {
  async change(userId: string, input: ChangePasswordInput): Promise<void> {
    const user = await loadActiveAuthUser(userId);

    if (!user.passwordHash) {
      throw new BadRequestError("AUTH_PASSWORD_NOT_SET");
    }

    const currentValid = await bcrypt.compare(
      input.currentPassword,
      user.passwordHash
    );
    if (!currentValid) {
      throw new UnauthorizedError("AUTH_CURRENT_PASSWORD_INVALID");
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
    publishPasswordChangedSafe({ userId, at: new Date().toISOString() });

    const active = await sessionRepository.listActiveSessionIds(userId);
    await authRepository.revokeSessionsAfterPasswordChange(userId);
    await markSessionsRevoked(active.map((row) => row.id));
  },
};
