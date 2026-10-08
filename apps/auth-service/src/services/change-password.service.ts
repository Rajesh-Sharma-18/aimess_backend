import bcrypt from "bcryptjs";

import { BadRequestError } from "@aimess/errors";
import {
  publishAdminActivitySafe,
  USER_AUDIT_ACTIONS,
} from "@aimess/messaging";

import type { ChangePasswordInput } from "../api/validators/change-password.validator.js";
import { loadActiveAuthUser } from "../lib/account-guard.js";
import { publishPasswordChangedSafe } from "../messaging/publish-auth-security.js";
import { authRepository } from "../repositories/auth.repository.js";

export const changePasswordService = {
  // Other devices are signed out only when the user confirms the client prompt
  // (POST /auth/sessions/revoke-all). Password RESET still revokes everything.
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

    publishPasswordChangedSafe({ userId, at: new Date().toISOString() });

    publishAdminActivitySafe({
      actorId: userId,
      action: USER_AUDIT_ACTIONS.USER_PASSWORD_CHANGED,
      targetType: "user",
      targetId: userId,
    });
  },
};
