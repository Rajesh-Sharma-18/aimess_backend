import { ConflictError, ForbiddenError, NotFoundError } from "@aimess/errors";

import { AUDIT_ACTIONS, ROLE_KEYS } from "../constants/index.js";
import type { RoleKey } from "../generated/prisma/client.js";
import { hashPassword } from "../lib/password.js";
import { markAdminSessionsRevoked } from "../lib/admin-session-cache.js";
import { resolveAvatarOrNull } from "../lib/avatar-media.js";
import {
  adminSessionRepository,
  adminUserRepository,
} from "../repositories/index.js";
import type {
  AdminAccountDetail,
  AdminAccountListItem,
  AdminPermissionsView,
  CreateAdminAccountInput,
  ListAdminAccountsQuery,
  Paginated,
  PermissionCatalogueItem,
  UpdateAdminAccountInput,
  UpdateAdminPermissionsInput,
} from "../types/admin-account.types.js";
import type { RequestAdmin } from "../types/index.js";
import { auditService } from "./audit.service.js";
import { rbacService } from "./rbac.service.js";

/** Per-request context used for audit rows (mirrors AdminRequestContext). */
export type AdminAccountRequestContext = {
  ip: string;
  userAgent?: string | null;
};

/** Row shape returned by `adminUserRepository` (create/find/update all `include: { role: true }`). */
type AdminRow = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  status: string;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  role: { key: RoleKey; name: string };
};

async function toListItem(row: AdminRow): Promise<AdminAccountListItem> {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatar: await resolveAvatarOrNull(row.avatarUrl),
    role: { key: row.role.key, name: row.role.name },
    status: row.status as AdminAccountListItem["status"],
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.getTime() : null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/**
 * SUPER_ADMIN accounts can only be created/edited/deactivated/re-permissioned
 * by another SUPER_ADMIN, and only a SUPER_ADMIN can grant the SUPER_ADMIN
 * role to anyone. Every other role is manageable by any admin holding
 * `admins.manage`.
 */
function assertCanManageRole(actorRole: string, roleKey: string): void {
  if (
    roleKey === ROLE_KEYS.SUPER_ADMIN &&
    actorRole !== ROLE_KEYS.SUPER_ADMIN
  ) {
    throw new ForbiddenError("ADMIN_FORBIDDEN");
  }
}

export const adminAccountService = {
  async listAdminAccounts(
    query: ListAdminAccountsQuery
  ): Promise<Paginated<AdminAccountListItem>> {
    const { rows, total } = await adminUserRepository.list(query);
    const totalPages = total === 0 ? 0 : Math.ceil(total / query.limit);
    return {
      data: await Promise.all(rows.map(toListItem)),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages,
        hasNext: query.page * query.limit < total,
        hasPrev: query.page > 1,
      },
    };
  },

  async getAdminAccount(id: string): Promise<AdminAccountDetail> {
    const admin = await adminUserRepository.findById(id);
    if (!admin) throw new NotFoundError("ADMIN_NOT_FOUND");
    return toListItem(admin);
  },

  /** Create a new admin account. Rejects duplicate emails and unauthorized SUPER_ADMIN grants. */
  async createAdminAccount(
    input: CreateAdminAccountInput,
    actor: RequestAdmin,
    ctx: AdminAccountRequestContext
  ): Promise<AdminAccountDetail> {
    assertCanManageRole(actor.role, input.roleKey);

    const existing = await adminUserRepository.findByEmail(input.email);
    if (existing) throw new ConflictError("ADMIN_EMAIL_TAKEN");

    const role = await adminUserRepository.findRoleByKey(
      input.roleKey as RoleKey
    );
    if (!role) throw new NotFoundError("ADMIN_ROLE_NOT_FOUND");

    let created;
    try {
      created = await adminUserRepository.createAdmin({
        email: input.email,
        passwordHash: await hashPassword(input.password),
        name: input.name,
        roleId: role.id,
      });
    } catch (error) {
      if (isUniqueEmailViolation(error)) {
        throw new ConflictError("ADMIN_EMAIL_TAKEN");
      }
      throw error;
    }

    if (input.avatarUrl !== undefined) {
      created = await adminUserRepository.updateProfile(created.id, {
        avatarUrl: input.avatarUrl,
      });
    }

    await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.ADMIN_CREATED,
      targetType: "admin",
      targetId: created.id,
      after: { email: created.email, name: created.name, role: role.key },
      ip: ctx.ip,
      userAgent: ctx.userAgent ?? null,
    });

    return toListItem(created);
  },

  /** Update profile fields (name/avatarUrl). Role/permission changes go through updateAdminPermissions. */
  async updateAdminAccount(
    id: string,
    input: UpdateAdminAccountInput,
    actor: RequestAdmin,
    ctx: AdminAccountRequestContext
  ): Promise<AdminAccountDetail> {
    const existing = await adminUserRepository.findById(id);
    if (!existing) throw new NotFoundError("ADMIN_NOT_FOUND");
    assertCanManageRole(actor.role, existing.role.key);

    const updated = await adminUserRepository.updateProfile(id, input);

    await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.ADMIN_UPDATED,
      targetType: "admin",
      targetId: id,
      before: { name: existing.name, avatarUrl: existing.avatarUrl },
      after: { name: updated.name, avatarUrl: updated.avatarUrl },
      ip: ctx.ip,
      userAgent: ctx.userAgent ?? null,
    });

    return toListItem(updated);
  },

  /** Activate a DISABLED/INVITED admin account. */
  async activateAdminAccount(
    id: string,
    actor: RequestAdmin,
    ctx: AdminAccountRequestContext
  ): Promise<AdminAccountDetail> {
    const existing = await adminUserRepository.findById(id);
    if (!existing) throw new NotFoundError("ADMIN_NOT_FOUND");
    assertCanManageRole(actor.role, existing.role.key);

    if (existing.status === "ACTIVE") {
      throw new ConflictError("ADMIN_ALREADY_ACTIVE");
    }

    await adminUserRepository.setStatus(id, "ACTIVE");
    const updated = await adminUserRepository.findById(id);
    if (!updated) throw new NotFoundError("ADMIN_NOT_FOUND");

    await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.ADMIN_ACTIVATED,
      targetType: "admin",
      targetId: id,
      before: { status: existing.status },
      after: { status: "ACTIVE" },
      ip: ctx.ip,
      userAgent: ctx.userAgent ?? null,
    });

    return toListItem(updated);
  },

  /**
   * Deactivate an admin account. Rejects self-deactivation and revokes every
   * active session for the target so already-issued tokens stop working.
   */
  async deactivateAdminAccount(
    id: string,
    actor: RequestAdmin,
    ctx: AdminAccountRequestContext
  ): Promise<AdminAccountDetail> {
    if (id === actor.id) {
      throw new ForbiddenError("ADMIN_CANNOT_DEACTIVATE_SELF");
    }

    const existing = await adminUserRepository.findById(id);
    if (!existing) throw new NotFoundError("ADMIN_NOT_FOUND");
    assertCanManageRole(actor.role, existing.role.key);

    if (existing.status === "DISABLED") {
      throw new ConflictError("ADMIN_ALREADY_INACTIVE");
    }

    await adminUserRepository.setStatus(id, "DISABLED");
    const updated = await adminUserRepository.findById(id);
    if (!updated) throw new NotFoundError("ADMIN_NOT_FOUND");

    const activeSessions = await adminSessionRepository.listActiveByAdmin(id);
    await adminSessionRepository.revokeAllForAdmin(id);
    await markAdminSessionsRevoked(activeSessions.map((s) => s.id));

    await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.ADMIN_DEACTIVATED,
      targetType: "admin",
      targetId: id,
      before: { status: existing.status },
      after: { status: "DISABLED" },
      ip: ctx.ip,
      userAgent: ctx.userAgent ?? null,
    });

    return toListItem(updated);
  },

  /** The full permission catalogue (for building a role/permission picker UI). */
  async listPermissions(): Promise<PermissionCatalogueItem[]> {
    const rows = await rbacService.listPermissions();
    return rows.map((r) => ({ key: r.key, group: r.group }));
  },

  /** The resolved (role-derived) permission set for one admin. */
  async getAdminPermissions(id: string): Promise<AdminPermissionsView> {
    const admin = await adminUserRepository.findById(id);
    if (!admin) throw new NotFoundError("ADMIN_NOT_FOUND");

    const permissions = await rbacService.getPermissionKeysForRole(
      admin.role.key
    );
    return {
      adminId: admin.id,
      role: { key: admin.role.key, name: admin.role.name },
      permissions,
    };
  },

  /**
   * Reassign an admin's role — the only mutable "permission" surface in this
   * RBAC model (permissions are derived from the role, not per-admin). Cannot
   * grant/hold SUPER_ADMIN unless the actor is themselves a SUPER_ADMIN.
   */
  async updateAdminPermissions(
    id: string,
    input: UpdateAdminPermissionsInput,
    actor: RequestAdmin,
    ctx: AdminAccountRequestContext
  ): Promise<AdminPermissionsView> {
    const existing = await adminUserRepository.findById(id);
    if (!existing) throw new NotFoundError("ADMIN_NOT_FOUND");
    assertCanManageRole(actor.role, existing.role.key);
    assertCanManageRole(actor.role, input.roleKey);

    const role = await adminUserRepository.findRoleByKey(
      input.roleKey as RoleKey
    );
    if (!role) throw new NotFoundError("ADMIN_ROLE_NOT_FOUND");

    const updated = await adminUserRepository.updateRole(id, role.id);
    const permissions = await rbacService.getPermissionKeysForRole(role.key);

    await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.ADMIN_PERMISSIONS_UPDATED,
      targetType: "admin",
      targetId: id,
      before: { role: existing.role.key },
      after: { role: role.key },
      ip: ctx.ip,
      userAgent: ctx.userAgent ?? null,
    });

    return {
      adminId: updated.id,
      role: { key: updated.role.key, name: updated.role.name },
      permissions,
    };
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
