import { ForbiddenError, UnauthorizedError } from "@aimess/errors";

import { AUDIT_ACTIONS } from "../constants/index.js";
import type { RoleKey } from "../generated/prisma/client.js";
import {
  newJti,
  signAdminAccessToken,
  signAdminRefreshToken,
  verifyAdminRefreshToken,
} from "../lib/admin-jwt.js";
import { blacklistJti } from "../lib/jti-blacklist.js";
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

  const accessJti = newJti();
  const refreshJti = newJti();

  const access = signAdminAccessToken({
    adminId: admin.id,
    role: admin.role.key,
    permissions,
    jti: accessJti,
  });
  const refresh = signAdminRefreshToken({ adminId: admin.id, jti: refreshJti });

  await adminSessionRepository.create({
    adminId: admin.id,
    jti: accessJti,
    ip: ctx.ip,
    userAgent: ctx.userAgent ?? null,
    expiresAt: new Date(Date.now() + access.expiresInSeconds * 1000),
  });

  return {
    tokens: {
      accessToken: access.token,
      refreshToken: refresh.token,
      accessTokenExpiresIn: access.expiresInSeconds,
      refreshTokenExpiresIn: refresh.expiresInSeconds,
    },
    admin: buildAdminProfile(admin, permissions),
  };
}

export const adminAuthService = {
  /**
   * Single-step login: email + password. Verifies the credentials, issues the
   * admin access + refresh tokens, persists the session, and records the login.
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
    if (admin.status === "DISABLED") {
      throw new ForbiddenError("Account disabled");
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

  /** Rotate the admin access/refresh pair from a valid refresh token. */
  async refresh(
    refreshToken: string,
    ctx: AdminRequestContext
  ): Promise<AdminAuthResult> {
    const { adminId } = verifyAdminRefreshToken(refreshToken);

    const admin = await adminUserRepository.findById(adminId);
    if (!admin) {
      throw new UnauthorizedError("AUTH_INVALID_TOKEN");
    }
    if (admin.status === "DISABLED") {
      throw new ForbiddenError("Account disabled");
    }

    const result = await issueAdminSession(admin, ctx);
    await auditService.record({
      actorId: admin.id,
      action: AUDIT_ACTIONS.ADMIN_TOKEN_REFRESHED,
      targetType: "admin",
      targetId: admin.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent ?? null,
    });
    return result;
  },

  /** Blacklist the current access jti + revoke its session row. */
  async logout(
    adminId: string,
    jti: string,
    ctx: AdminRequestContext
  ): Promise<void> {
    const session = await adminSessionRepository.findByJti(jti);
    if (session) {
      const ttlSeconds = Math.max(
        1,
        Math.ceil((session.expiresAt.getTime() - Date.now()) / 1000)
      );
      await blacklistJti(jti, ttlSeconds);
      await adminSessionRepository.revoke(jti);
    } else {
      // Fall back to a default TTL so logout still revokes a tokenless-session jti.
      await blacklistJti(jti, 8 * 60 * 60);
    }

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
