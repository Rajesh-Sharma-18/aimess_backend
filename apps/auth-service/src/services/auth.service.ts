import type { Request } from "express";

import { ConflictError, UnauthorizedError } from "@aimess/errors";
import bcrypt from "bcryptjs";

import type {
  LoginInput,
  RegisterInput,
} from "../api/validators/auth.validator.js";
import { AccountStatus } from "../generated/prisma/client.js";
import { env } from "../config/env.js";
import {
  isEmailLoginIdentifier,
  normalizeLoginIdentifier,
} from "../lib/login-identifier.js";
import { buildSessionContext } from "../lib/session-context.js";
import { issueAuthTokens } from "../lib/token.js";
import { publishUserCreatedSafe } from "../messaging/publish-user-created.js";
import { authRepository } from "../repositories/auth.repository.js";
import type { LoginResult, RegisterResult } from "../types/index.js";

export const authService = {
  async register(req: Request, input: RegisterInput): Promise<RegisterResult> {
    const account = input.account;

    const existingAccount = await authRepository.findByAccount(account);

    if (existingAccount) {
      throw new ConflictError("AUTH_ACCOUNT_TAKEN");
    }

    const passwordHash = await bcrypt.hash(input.password, 12);

    const user = await authRepository.createUser({
      account,
      passwordHash,
      lastPasswordChangeAt: new Date(),
    });

    const session = buildSessionContext(req);
    const { tokens } = await issueAuthTokens(user.id, session);

    publishUserCreatedSafe({
      userId: user.id,
      account: user.account,
      createdAt: user.createdAt.toISOString(),
    });

    return {
      user: {
        userId: user.id,
        account: user.account,
        createdAt: user.createdAt.toISOString(),
      },
      tokens,
    };
  },

  async login(req: Request, input: LoginInput): Promise<LoginResult> {
    const identifier = normalizeLoginIdentifier(input.account);
    const user = isEmailLoginIdentifier(identifier)
      ? await authRepository.findByEmailForLogin(identifier)
      : await authRepository.findByAccountForLogin(identifier);

    if (!user || user.deletedAt) {
      throw new UnauthorizedError("AUTH_INVALID_CREDENTIALS");
    }

    if (isEmailLoginIdentifier(identifier) && !user.emailVerified) {
      throw new UnauthorizedError("AUTH_INVALID_CREDENTIALS");
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedError("AUTH_ACCOUNT_LOCKED");
    }

    if (user.status !== AccountStatus.ACTIVE) {
      throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
    }

    if (!user.passwordHash) {
      throw new UnauthorizedError("AUTH_PASSWORD_NOT_SET");
    }

    const passwordValid = await bcrypt.compare(
      input.password,
      user.passwordHash
    );
    if (!passwordValid) {
      await authRepository.recordFailedLogin(
        user.id,
        env.AUTH_MAX_FAILED_LOGINS,
        env.AUTH_LOCKOUT_MINUTES
      );
      throw new UnauthorizedError("AUTH_INVALID_CREDENTIALS");
    }

    await authRepository.recordSuccessfulLogin(user.id);

    const session = buildSessionContext(req);
    const { tokens } = await issueAuthTokens(user.id, session);

    return {
      tokens,
    };
  },
};
