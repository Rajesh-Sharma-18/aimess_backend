import { NotFoundError } from "@aimess/errors";

import { markSessionsRevoked } from "../lib/session-active-cache.js";
import { authRepository } from "../repositories/auth.repository.js";

export type DeleteAccountResult = {
  deletedAt: string;
};

export const accountDeletionService = {
  async deleteAccount(email: string): Promise<DeleteAccountResult> {
    const user = await authRepository.findByEmail(email);

    if (!user) {
      throw new NotFoundError("AUTH_ACCOUNT_NOT_ACTIVE");
    }

    const { deletedAt, revokedSessionIds } =
      await authRepository.hardDeleteUser(user.id);

    await markSessionsRevoked(revokedSessionIds);

    return { deletedAt: deletedAt.toISOString() };
  },
};
