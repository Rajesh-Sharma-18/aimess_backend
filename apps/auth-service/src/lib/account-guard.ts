import { UnauthorizedError } from "@aimess/errors";

import { AccountStatus } from "../generated/prisma/client.js";
import { authRepository } from "../repositories/auth.repository.js";

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

  if (!user || user.deletedAt) {
    throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
  }

  if (user.status !== AccountStatus.ACTIVE) {
    throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
  }

  return user;
}
