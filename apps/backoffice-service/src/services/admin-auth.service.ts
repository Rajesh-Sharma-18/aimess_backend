import { ForbiddenError, UnauthorizedError } from "@aimess/errors";

import { env } from "../config/env.js";
import { AUDIT_ACTIONS } from "../constants/index.js";
import type { RoleKey } from "../generated/prisma/client.js";
import {
  parseExpiresInSeconds,
  signAdminAccessToken,
} from "../lib/admin-jwt.js";
import {
  markAdminSessionActive,
  markAdminSessionRevoked,
  markAdminSessionsRevoked,
} from "../lib/admin-session-cache.js";
import { resolveAdminAvatarUrl } from "../lib/admin-avatar.js";
import { createRefreshTokenValue, hashToken } from "../lib/admin-token.js";
import { verifyPassword } from "../lib/password.js";
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
  /** Always present: custom avatar if set, otherwise a system-generated default. */
  avatarUrl: string;
  role: RoleKey;
  status: string;
  lastLoginAt: Date | null;
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

function buildAdminProfile(
  admin: AdminProfileSource,
  permissions: string[]
): AdminProfile {
  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    avatarUrl: resolveAdminAvatarUrl(admin),
    role: admin.role.key,
    status: admin.status,
    lastLoginAt: admin.lastLoginAt,
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
    admin: buildAdminProfile(admin, permissions),
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
      admin: buildAdminProfile(admin, permissions),
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
    return buildAdminProfile(admin, permissions);
  },
};
