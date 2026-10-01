import { NotFoundError } from "@aimess/errors";

import { AuthProvider } from "../generated/prisma/client.js";
import { loadActiveAuthUser } from "../lib/account-guard.js";
import { assertEmailAvailable } from "../lib/email-availability.js";
import { rethrowAsEmailConflict } from "../lib/email-conflict.js";
import { normalizeEmail } from "../lib/otp.js";
import { emitProfileUpdatedSafe } from "../lib/profile-socket.js";
import { authRepository } from "../repositories/auth.repository.js";

export type AdminLinkedProvider = {
  provider: "GOOGLE" | "APPLE";
  providerEmail: string | null;
  linkedAt: string;
};

export type AdminUserIdentity = {
  email: string | null;
  emailVerified: boolean;
  hasPassword: boolean;
  providers: AdminLinkedProvider[];
};

export type AdminSetEmailResult = {
  changed: boolean;
  previousEmail: string | null;
  email: string;
};

export const adminIdentityService = {
  async getIdentity(userId: string): Promise<AdminUserIdentity> {
    const row = await authRepository.findByIdForAdminIdentity(userId);
    if (!row) {
      throw new NotFoundError("USER_NOT_FOUND");
    }

    return {
      email: row.email,
      emailVerified: row.emailVerified,
      hasPassword: Boolean(row.passwordHash),
      providers: row.linkedAccounts.flatMap((link) =>
        link.provider === AuthProvider.GOOGLE ||
        link.provider === AuthProvider.APPLE
          ? [
              {
                provider: link.provider,
                providerEmail: link.email,
                linkedAt: link.linkedAt.toISOString(),
              },
            ]
          : []
      ),
    };
  },

  async setEmail(
    userId: string,
    rawEmail: string
  ): Promise<AdminSetEmailResult> {
    const email = normalizeEmail(rawEmail);
    const user = await loadActiveAuthUser(userId);

    if (user.email === email) {
      return { changed: false, previousEmail: user.email, email };
    }

    await assertEmailAvailable(email, userId);
    await authRepository
      .setUnverifiedEmail(userId, email)
      .catch(rethrowAsEmailConflict);

    emitProfileUpdatedSafe(userId);

    return { changed: true, previousEmail: user.email, email };
  },
};
