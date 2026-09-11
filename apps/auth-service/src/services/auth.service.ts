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
import { AccountStatus, AuthProvider } from "../generated/prisma/client.js";
import { env } from "../config/env.js";
import {
  isEmailLoginIdentifier,
  normalizeLoginIdentifier,
} from "../lib/login-identifier.js";
import { assertNotBanned } from "../lib/account-guard.js";
import { resolveRequiredSocialProvider } from "../lib/sign-in-methods.js";
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

    if (!user) {
      auditFailure("ACCOUNT_NOT_FOUND");
      throw new UnauthorizedError("AUTH_INVALID_CREDENTIALS");
    }

    // A soft-deleted account is named as deleted — but only to someone who
    // typed its password correctly.
    //
    // This branch used to answer AUTH_INVALID_CREDENTIALS for every caller,
    // which made a deleted account indistinguishable from one that never
    // existed. That ambiguity is worth keeping against a guessing attacker and
    // worth nothing against the person whose account it is: "incorrect account
    // or password" sends them to reset a password that is fine, over and over.
    // Verifying the credential first keeps both — the right answer for the
    // owner, an unchanged one for anybody else — so this is not an enumeration
    // oracle: without the password the response is byte-identical to before.
    //
    // Deliberately BEFORE the locked/banned/status checks: a soft delete also
    // sets status to PENDING_DELETION, and reaching those would answer
    // AUTH_ACCOUNT_NOT_ACTIVE ("your account has been disabled") for an account
    // the user deleted themselves. Nothing below this point can run for a
    // deleted account, so no failed-attempt counter moves and no token is ever
    // issued.
    if (user.deletedAt) {
      const passwordValid = user.passwordHash
        ? await bcrypt.compare(input.password, user.passwordHash)
        : false;
      auditFailure("ACCOUNT_DELETED", user.id);
      throw new UnauthorizedError(
        passwordValid ? "AUTH_ACCOUNT_DELETED" : "AUTH_INVALID_CREDENTIALS"
      );
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

    // Password authentication is unavailable on this account — and ONLY here,
    // where that is already true, may a linked provider be named. An account
    // that has a hash falls through to the credential check below however many
    // providers it has linked, so "also linked to Google" never blocks a
    // password that works.
    //
    // This narrows the reason rather than widening what login reveals: the
    // generic AUTH_PASSWORD_NOT_SET this replaces already answered on exactly
    // this branch, so an account-name that reaches it was already
    // distinguishable from an unknown one. What changes is that the client can
    // now say WHICH button to press instead of "incorrect account or password",
    // which is simply false for a credential that was never set.
    if (!user.passwordHash) {
      const provider = resolveRequiredSocialProvider(user);
      auditFailure(
        provider ? `PASSWORD_NOT_SET_${provider}` : "PASSWORD_NOT_SET",
        user.id
      );
      if (provider === AuthProvider.GOOGLE) {
        throw new UnauthorizedError("AUTH_GOOGLE_LOGIN_REQUIRED");
      }
      if (provider === AuthProvider.APPLE) {
        throw new UnauthorizedError("AUTH_APPLE_LOGIN_REQUIRED");
      }
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
