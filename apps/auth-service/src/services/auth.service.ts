import type { Request } from "express";

import { ConflictError, UnauthorizedError } from "@aimess/errors";
import {
  publishAdminActivitySafe,
  USER_AUDIT_ACTIONS,
} from "@aimess/messaging";
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
import { assertNotBanned } from "../lib/account-guard.js";
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

    const session = buildSessionContext(req, input.device);
    const { tokens } = await issueAuthTokens(
      user.id,
      user.role === "ADMIN" ? "ADMIN" : "USER",
      session,
      undefined,
      // First session on a brand-new account — no other devices to alert.
      { notifyNewLogin: false }
    );

    publishUserCreatedSafe({
      userId: user.id,
      account: user.account,
      createdAt: user.createdAt.toISOString(),
      isGoogleLogin: false,
    });

    publishAdminActivitySafe({
      actorId: user.id,
      action: USER_AUDIT_ACTIONS.USER_REGISTERED,
      targetType: "user",
      targetId: user.id,
      after: { account: user.account },
      ip: session.ipAddress,
      userAgent: session.userAgent,
    });

    return {
      user: {
        userId: user.id,
        account: user.account,
        role: user.role,
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

    // Every rejected login is audited, not just a wrong password: an attack against
    // unknown or locked accounts is exactly the pattern this action exists to expose.
    // An unknown identifier has no actor, so it is recorded as SYSTEM.
    const auditFailure = (reason: string, userId?: string) => {
      const failed = buildSessionContext(req);
      publishAdminActivitySafe({
        actorId: userId ?? null,
        actorType: userId ? "USER" : "SYSTEM",
        action: USER_AUDIT_ACTIONS.USER_LOGIN_FAILED,
        targetType: "user",
        targetId: userId ?? identifier,
        after: { reason, identifier },
        ip: failed.ipAddress,
        userAgent: failed.userAgent,
      });
    };

    if (!user || user.deletedAt) {
      auditFailure(user ? "ACCOUNT_DELETED" : "ACCOUNT_NOT_FOUND", user?.id);
      throw new UnauthorizedError("AUTH_INVALID_CREDENTIALS");
    }

    if (isEmailLoginIdentifier(identifier) && !user.emailVerified) {
      auditFailure("EMAIL_NOT_VERIFIED", user.id);
      throw new UnauthorizedError("AUTH_INVALID_CREDENTIALS");
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      auditFailure("ACCOUNT_LOCKED", user.id);
      throw new UnauthorizedError("AUTH_ACCOUNT_LOCKED");
    }

    if (user.status === AccountStatus.BANNED) {
      auditFailure("ACCOUNT_BANNED", user.id);
      assertNotBanned(user.status);
    }

    if (user.status !== AccountStatus.ACTIVE) {
      auditFailure(`ACCOUNT_${user.status}`, user.id);
      throw new UnauthorizedError("AUTH_ACCOUNT_NOT_ACTIVE");
    }

    if (!user.passwordHash) {
      auditFailure("PASSWORD_NOT_SET", user.id);
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
      auditFailure("INVALID_PASSWORD", user.id);
      throw new UnauthorizedError("AUTH_INVALID_CREDENTIALS");
    }

    await authRepository.recordSuccessfulLogin(user.id);
    await authRepository.mergeFcmTokens(user.id, input.fcmTokens);

    // The "New login detected" alert now fires from issueAuthTokens (the shared
    // new-session funnel) once the session row + id + device metadata exist.
    const session = buildSessionContext(req, input.device);
    const { tokens } = await issueAuthTokens(
      user.id,
      user.role === "ADMIN" ? "ADMIN" : "USER",
      session,
      input.rememberMe
    );

    return {
      tokens,
      isProfileCompleted: user.isProfileCompleted,
      role: user.role,
    };
  },
};
