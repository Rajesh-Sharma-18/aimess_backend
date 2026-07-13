import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "@aimess/errors";

import { env } from "../config/env.js";
import { AUDIT_ACTIONS } from "../constants/index.js";
import type { RoleKey } from "../generated/prisma/client.js";
import {
  parseExpiresInSeconds,
  signAdminAccessToken,
} from "../lib/admin-jwt.js";
import { assertAdminAccountAccessible } from "../lib/admin-status-guard.js";
import {
  markAdminSessionActive,
  markAdminSessionRevoked,
  markAdminSessionsRevoked,
} from "../lib/admin-session-cache.js";
import { resolveAvatarOrNull } from "../lib/avatar-media.js";
import type { MediaObject } from "@aimess/shared-types";
import { createRefreshTokenValue, hashToken } from "../lib/admin-token.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import {
  adminSessionRepository,
  adminUserRepository,
} from "../repositories/index.js";
import { auditService } from "./audit.service.js";
import { rbacService } from "./rbac.service.js";

/** Per-request context used for audit + session rows. */
export type AdminRequestContext = {
  ip: string;
  userAgent?: string | null;
};

export type AdminTokensResponse = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
};

export type AdminProfile = {
  id: string;
  email: string;
  name: string;
  // Standard avatar object (see @aimess/shared-types MediaObject); null when
  // no avatar is set. Replaces the legacy bare avatarUrl string.
  avatar: MediaObject | null;
  role: RoleKey;
  status: string;
  lastLoginAt: number | null;
  permissions: string[];
};

/** Login/refresh response payload (mirrors auth-service's `{ tokens, ... }`). */
export type AdminAuthResult = {
  tokens: AdminTokensResponse;
  admin: AdminProfile;
};

/** Account record fields needed to build the public admin profile. */
type AdminProfileSource = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: { key: RoleKey };
  status: string;
  lastLoginAt: Date | null;
};

async function buildAdminProfile(
  admin: AdminProfileSource,
  permissions: string[]
): Promise<AdminProfile> {
  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    avatar: await resolveAvatarOrNull(admin.avatarUrl),
    role: admin.role.key,
    status: admin.status,
    lastLoginAt: admin.lastLoginAt?.getTime() ?? null,
    permissions,
  };
}

async function issueAdminSession(
  admin: AdminProfileSource,
  ctx: AdminRequestContext
): Promise<AdminAuthResult> {
  const permissions = await rbacService.getPermissionKeysForRole(
    admin.role.key
  );

  const refreshTokenExpiresIn = parseExpiresInSeconds(
    env.JWT_ADMIN_REFRESH_EXPIRES_IN
  );
  const refreshToken = createRefreshTokenValue();
  const refreshExpiresAt = new Date(Date.now() + refreshTokenExpiresIn * 1000);

  const session = await adminSessionRepository.create({
    adminId: admin.id,
    refreshTokenHash: hashToken(refreshToken),
    refreshExpiresAt,
    ip: ctx.ip,
    userAgent: ctx.userAgent ?? null,
  });

  const access = signAdminAccessToken({
    adminId: admin.id,
    sessionId: session.id,
  });

  await markAdminSessionActive(session.id);

  return {
    tokens: {
      accessToken: access.token,
      refreshToken,
      accessTokenExpiresIn: access.expiresInSeconds,
      refreshTokenExpiresIn,
    },
    admin: await buildAdminProfile(admin, permissions),
  };
}

export const adminAuthService = {
  /**
   * Single-step login: email + password. Verifies the credentials, issues the
   * admin access + opaque refresh token, persists the session, and records the
   * login.
   */
  async login(
    email: string,
    password: string,
    ctx: AdminRequestContext
  ): Promise<AdminAuthResult> {
    const admin = await adminUserRepository.findByEmail(email);
    if (!admin) {
      throw new UnauthorizedError("AUTH_INVALID_CREDENTIALS");
    }
    if (admin.status !== "ACTIVE") {
      throw new ForbiddenError("ADMIN_ACCOUNT_NOT_ACTIVE");
    }

    const ok = await verifyPassword(password, admin.passwordHash);
    if (!ok) {
      throw new UnauthorizedError("AUTH_INVALID_CREDENTIALS");
    }

    const result = await issueAdminSession(admin, ctx);
    await adminUserRepository.updateLastLogin(admin.id);
    await auditService.record({
      actorId: admin.id,
      action: AUDIT_ACTIONS.ADMIN_LOGIN,
      targetType: "admin",
      targetId: admin.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent ?? null,
    });

    return result;
  },

  /**
   * Rotate the admin access/refresh pair from a valid opaque refresh token.
   * Implements rotation with reuse detection: a refresh token that was already
   * rotated triggers a full revocation of the admin's sessions.
   */
  async refresh(
    refreshToken: string,
    ctx: AdminRequestContext
  ): Promise<AdminAuthResult> {
    const stored = await adminSessionRepository.findByRefreshTokenHash(
      hashToken(refreshToken)
    );
    if (!stored) {
      throw new UnauthorizedError("AUTH_INVALID_TOKEN");
    }

    // Reuse detection: this token was already rotated. Treat as compromise and
    // revoke every active session for the admin.
    if (stored.rotatedToId) {
      const active = await adminSessionRepository.listActiveByAdmin(
        stored.adminId
      );
      await adminSessionRepository.revokeAllForAdmin(stored.adminId);
      await markAdminSessionsRevoked(active.map((r) => r.id));
      throw new UnauthorizedError("AUTH_INVALID_TOKEN");
    }

    if (stored.revokedAt) {
      throw new UnauthorizedError("AUTH_INVALID_TOKEN");
    }
    if (stored.refreshExpiresAt <= new Date()) {
      throw new UnauthorizedError("AUTH_TOKEN_EXPIRED");
    }

    const admin = await adminUserRepository.findById(stored.adminId);
    if (!admin) {
      throw new UnauthorizedError("AUTH_INVALID_TOKEN");
    }
    if (admin.status !== "ACTIVE") {
      throw new ForbiddenError("ADMIN_ACCOUNT_NOT_ACTIVE");
    }

    const permissions = await rbacService.getPermissionKeysForRole(
      admin.role.key
    );

    const refreshTokenExpiresIn = parseExpiresInSeconds(
      env.JWT_ADMIN_REFRESH_EXPIRES_IN
    );
    const newRefresh = createRefreshTokenValue();
    const newRefreshExpiresAt = new Date(
      Date.now() + refreshTokenExpiresIn * 1000
    );

    const newSession = await adminSessionRepository.rotate({
      oldSessionId: stored.id,
      adminId: stored.adminId,
      newRefreshTokenHash: hashToken(newRefresh),
      newRefreshExpiresAt,
      ip: ctx.ip,
      userAgent: ctx.userAgent ?? null,
    });
    if (!newSession) {
      // Concurrent refresh already rotated this token.
      throw new UnauthorizedError("AUTH_INVALID_TOKEN");
    }

    const access = signAdminAccessToken({
      adminId: stored.adminId,
      sessionId: newSession.id,
    });

    await markAdminSessionActive(newSession.id);

    await auditService.record({
      actorId: admin.id,
      action: AUDIT_ACTIONS.ADMIN_TOKEN_REFRESHED,
      targetType: "admin",
      targetId: admin.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent ?? null,
    });

    return {
      tokens: {
        accessToken: access.token,
        refreshToken: newRefresh,
        accessTokenExpiresIn: access.expiresInSeconds,
        refreshTokenExpiresIn,
      },
      admin: await buildAdminProfile(admin, permissions),
    };
  },

  /** Revoke the current session row + active-session cache entry. */
  async logout(
    adminId: string,
    sessionId: string,
    ctx: AdminRequestContext
  ): Promise<void> {
    await adminSessionRepository.revoke(sessionId);
    await markAdminSessionRevoked(sessionId);

    await auditService.record({
      actorId: adminId,
      action: AUDIT_ACTIONS.ADMIN_LOGOUT,
      targetType: "admin",
      targetId: adminId,
      ip: ctx.ip,
      userAgent: ctx.userAgent ?? null,
    });
  },

  /** Current admin profile + resolved permissions. */
  async getMe(adminId: string): Promise<AdminProfile> {
    const admin = await adminUserRepository.findById(adminId);
    if (!admin) {
      throw new UnauthorizedError("AUTH_UNAUTHORIZED");
    }
    const permissions = await rbacService.getPermissionKeysForRole(
      admin.role.key
    );
    return await buildAdminProfile(admin, permissions);
  },

  /**
   * Self-service profile update for the "My Account" page (username, email,
   * avatar). Reuses `adminUserRepository.updateProfile`, `buildAdminProfile`
   * and the shared audit trail. Password changes go through `changePassword`.
   */
  async updateMe(
    adminId: string,
    input: {
      username?: string;
      email?: string;
      avatarObjectKey?: string | null;
    },
    ctx: AdminRequestContext
  ): Promise<AdminProfile> {
    const existing = await adminUserRepository.findById(adminId);
    if (!existing) {
      throw new UnauthorizedError("AUTH_UNAUTHORIZED");
    }

    // Case-insensitive email uniqueness — validator lowercases before we get here.
    if (input.email !== undefined && input.email !== existing.email) {
      const clash = await adminUserRepository.findByEmail(input.email);
      if (clash && clash.id !== adminId) {
        throw new ConflictError("ADMIN_EMAIL_TAKEN");
      }
    }

    let updated;
    try {
      updated = await adminUserRepository.updateProfile(adminId, {
        name: input.username,
        email: input.email,
        avatarUrl: input.avatarObjectKey,
      });
    } catch (error) {
      if (isUniqueEmailViolation(error)) {
        throw new ConflictError("ADMIN_EMAIL_TAKEN");
      }
      throw error;
    }

    await auditService.record({
      actorId: adminId,
      action: AUDIT_ACTIONS.ADMIN_PROFILE_UPDATED,
      targetType: "admin",
      targetId: adminId,
      before: {
        name: existing.name,
        email: existing.email,
        avatarUrl: existing.avatarUrl,
      },
      after: {
        name: updated.name,
        email: updated.email,
        avatarUrl: updated.avatarUrl,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent ?? null,
    });

    const permissions = await rbacService.getPermissionKeysForRole(
      updated.role.key
    );
    return buildAdminProfile(updated, permissions);
  },

  /**
   * Self-service password change for the "My Account" page. Verifies the
   * current password, hashes + persists the new one, and revokes every OTHER
   * active session (the caller's session is kept alive). Audited.
   */
  async changePassword(
    adminId: string,
    input: { currentPassword: string; newPassword: string },
    ctx: AdminRequestContext & { sessionId?: string }
  ): Promise<void> {
    const admin = await adminUserRepository.findById(adminId);
    if (!admin) {
      throw new NotFoundError("ADMIN_NOT_FOUND");
    }
    assertAdminAccountAccessible(admin);

    const ok = await verifyPassword(input.currentPassword, admin.passwordHash);
    if (!ok) {
      throw new BadRequestError("AUTH_CURRENT_PASSWORD_INVALID");
    }

    const sameAsCurrent = await verifyPassword(
      input.newPassword,
      admin.passwordHash
    );
    if (sameAsCurrent) {
      throw new BadRequestError("PASSWORD_SAME_AS_CURRENT");
    }

    await adminUserRepository.updatePasswordHash(
      adminId,
      await hashPassword(input.newPassword)
    );

    // Revoke every OTHER active session so stolen tokens stop working, but
    // keep the caller's current session alive so they don't get logged out.
    const active = await adminSessionRepository.listActiveByAdmin(adminId);
    const toRevoke = active
      .map((s) => s.id)
      .filter((sid) => sid !== ctx.sessionId);
    if (toRevoke.length > 0) {
      for (const sid of toRevoke) {
        await adminSessionRepository.revoke(sid);
      }
      await markAdminSessionsRevoked(toRevoke);
    }

    await auditService.record({
      actorId: adminId,
      action: AUDIT_ACTIONS.ADMIN_PASSWORD_CHANGED,
      targetType: "admin",
      targetId: adminId,
      ip: ctx.ip,
      userAgent: ctx.userAgent ?? null,
    });
  },
};

function isUniqueEmailViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
