import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@aimess/errors";

import { AUDIT_ACTIONS, PERMISSIONS, ROLE_KEYS } from "../constants/index.js";
import type { RoleKey } from "../generated/prisma/client.js";
import { hashPassword } from "../lib/password.js";
import { invalidateAdminPermissions } from "../lib/admin-perms-cache.js";
import { publishAdminSocketEvent } from "../lib/admin-socket-events.js";
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
  UpdateAdminAccountStatusInput,
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

/** Soft-deleted admins are gone in every functional sense — treat them as not found. */
function assertNotDeleted(status: string): void {
  if (status === "DELETED") {
    throw new NotFoundError("ADMIN_NOT_FOUND");
  }
}

/** `AdminPermissionsView` with the grid fields guaranteed present (the service always fills them). */
type AdminPermissionsSnapshot = AdminPermissionsView & {
  rolePermissions: string[];
  overrides: { key: string; allow: boolean }[];
};

/**
 * The effective set plus the two things the toggle grid needs to render without
 * a second call: the role baseline, and the per-admin deltas layered on it.
 */
async function buildPermissionsView(
  admin: AdminRow
): Promise<AdminPermissionsSnapshot> {
  const [permissions, rolePermissions, overrides] = await Promise.all([
    rbacService.getPermissionKeysForAdmin(admin.id, admin.role.key),
    rbacService.getPermissionKeysForRole(admin.role.key),
    rbacService.listOverridesForAdmin(admin.id),
  ]);
  return {
    adminId: admin.id,
    role: { key: admin.role.key, name: admin.role.name },
    permissions,
    rolePermissions,
    overrides: overrides.map((o) => ({
      key: o.permission.key,
      allow: o.allow,
    })),
  };
}

export const adminAccountService = {
  /**
   * SUPER_ADMIN rows are never listed — the role is the permission ceiling, so
   * there is nothing to grant or revoke on one, and a lesser admin can't manage
   * one at all (assertCanManageRole). Callers also never see their own row.
   */
  async listAdminAccounts(
    query: ListAdminAccountsQuery,
    actor: RequestAdmin
  ): Promise<Paginated<AdminAccountListItem>> {
    const { rows, total } = await adminUserRepository.list(query, {
      excludeAdminId: actor.id,
      excludeSuperAdmins: true,
    });
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

    const existingByName = await adminUserRepository.findByName(input.name);
    if (existingByName) throw new ConflictError("ADMIN_USERNAME_TAKEN");

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
    assertNotDeleted(existing.status);
    assertCanManageRole(actor.role, existing.role.key);

    if (input.email !== undefined && input.email !== existing.email) {
      const emailOwner = await adminUserRepository.findByEmail(input.email);
      if (emailOwner && emailOwner.id !== id) {
        throw new ConflictError("ADMIN_EMAIL_TAKEN");
      }
    }
    if (input.name !== undefined && input.name !== existing.name) {
      const nameOwner = await adminUserRepository.findByName(input.name);
      if (nameOwner && nameOwner.id !== id) {
        throw new ConflictError("ADMIN_USERNAME_TAKEN");
      }
    }

    let updated;
    try {
      updated = await adminUserRepository.updateProfile(id, input);
    } catch (error) {
      if (isUniqueEmailViolation(error)) {
        throw new ConflictError("ADMIN_EMAIL_TAKEN");
      }
      throw error;
    }

    await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.ADMIN_UPDATED,
      targetType: "admin",
      targetId: id,
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
    assertNotDeleted(existing.status);
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

    // Same invariant as the demote guard, by another door: disabling the last
    // effective `admins.manage` holder locks everyone out of admin management.
    // Excluding the target makes the count the state AFTER this deactivation.
    const otherHolders = await adminUserRepository.countActiveWithPermission(
      PERMISSIONS.ADMINS_MANAGE,
      id
    );
    if (otherHolders === 0) {
      throw new ConflictError("ADMIN_CANNOT_DEACTIVATE_LAST_SUPER_ADMIN");
    }

    await adminUserRepository.setStatus(id, "DISABLED");
    const updated = await adminUserRepository.findById(id);
    if (!updated) throw new NotFoundError("ADMIN_NOT_FOUND");

    const activeSessions = await adminSessionRepository.listActiveByAdmin(id);
    await adminSessionRepository.revokeAllForAdmin(id);
    await markAdminSessionsRevoked(activeSessions.map((s) => s.id));

    // Revoked tokens only bite on the target's next request, which for an idle
    // panel may be never — this pushes them out of the UI at the same moment.
    await publishAdminSocketEvent(id, "admin:session:revoked", {
      adminId: id,
      reason: "deactivated",
    });

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

  /**
   * Soft-delete a deactivated admin account: flips status to DELETED (the row
   * stays for audit/FK integrity), leaves it out of the list, and — like
   * deactivation — kills any lingering sessions. Only a DISABLED account can be
   * deleted, so the panel funnels every delete through deactivate first.
   */
  async deleteAdminAccount(
    id: string,
    actor: RequestAdmin,
    ctx: AdminAccountRequestContext
  ): Promise<AdminAccountDetail> {
    if (id === actor.id) {
      throw new ForbiddenError("ADMIN_CANNOT_DEACTIVATE_SELF");
    }

    const existing = await adminUserRepository.findById(id);
    if (!existing) throw new NotFoundError("ADMIN_NOT_FOUND");
    assertNotDeleted(existing.status);
    assertCanManageRole(actor.role, existing.role.key);

    if (existing.status !== "DISABLED") {
      throw new ConflictError("ADMIN_MUST_DEACTIVATE_BEFORE_DELETE");
    }

    await adminUserRepository.setStatus(id, "DELETED");
    const updated = await adminUserRepository.findById(id);
    if (!updated) throw new NotFoundError("ADMIN_NOT_FOUND");

    const activeSessions = await adminSessionRepository.listActiveByAdmin(id);
    await adminSessionRepository.revokeAllForAdmin(id);
    await markAdminSessionsRevoked(activeSessions.map((s) => s.id));

    await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.ADMIN_DELETED,
      targetType: "admin",
      targetId: id,
      before: { status: existing.status },
      after: { status: "DELETED" },
      ip: ctx.ip,
      userAgent: ctx.userAgent ?? null,
    });

    return toListItem(updated);
  },

  /**
   * Unified status toggle (PATCH .../status — Figma spec). Pure routing onto
   * activate/deactivate so the guardrails (self, last Super Admin, deleted)
   * live in exactly one place each.
   */
  updateAdminAccountStatus(
    id: string,
    input: UpdateAdminAccountStatusInput,
    actor: RequestAdmin,
    ctx: AdminAccountRequestContext
  ): Promise<AdminAccountDetail> {
    return input.status === "ACTIVE"
      ? this.activateAdminAccount(id, actor, ctx)
      : this.deactivateAdminAccount(id, actor, ctx);
  },

  /** The full permission catalogue (for building a role/permission picker UI). */
  async listPermissions(): Promise<PermissionCatalogueItem[]> {
    const rows = await rbacService.listPermissions();
    return rows.map((r) => ({ key: r.key, group: r.group }));
  },

  /** The effective permission set for one admin (role baseline + overrides). */
  async getAdminPermissions(id: string): Promise<AdminPermissionsView> {
    const admin = await adminUserRepository.findById(id);
    if (!admin) throw new NotFoundError("ADMIN_NOT_FOUND");
    return buildPermissionsView(admin);
  },

  /**
   * Apply a permission change: a role reassignment, the full desired permission
   * set from the toggle grid, or both. Cannot grant/hold SUPER_ADMIN unless the
   * actor is themselves a SUPER_ADMIN, and refuses to strip the platform of its
   * last admins.manage holder or to let an actor edit their own permissions.
   */
  async updateAdminPermissions(
    id: string,
    input: UpdateAdminPermissionsInput,
    actor: RequestAdmin,
    ctx: AdminAccountRequestContext
  ): Promise<AdminPermissionsView> {
    if (id === actor.id) {
      throw new ForbiddenError("ADMIN_CANNOT_EDIT_OWN_PERMISSIONS");
    }

    const existing = await adminUserRepository.findById(id);
    if (!existing) throw new NotFoundError("ADMIN_NOT_FOUND");
    assertCanManageRole(actor.role, existing.role.key);
    if (input.roleKey !== undefined) {
      assertCanManageRole(actor.role, input.roleKey);
    }

    const before = await buildPermissionsView(existing);

    const role =
      input.roleKey !== undefined
        ? await adminUserRepository.findRoleByKey(input.roleKey as RoleKey)
        : null;
    if (input.roleKey !== undefined && !role) {
      throw new NotFoundError("ADMIN_ROLE_NOT_FOUND");
    }

    // Deltas are always measured against the role the admin ends up on.
    const baseline = role
      ? await rbacService.getPermissionKeysForRole(role.key)
      : before.rolePermissions;

    let overrideRows: { permissionId: string; allow: boolean }[] | null = null;
    let desired: Set<string>;

    if (input.permissions !== undefined) {
      const submitted = [...new Set(input.permissions)];
      const catalogue = await rbacService.findPermissionsByKeys([
        ...new Set([...submitted, ...baseline]),
      ]);
      const idByKey = new Map(catalogue.map((p) => [p.key, p.id]));
      const unknown = submitted.filter((key) => !idByKey.has(key));
      if (unknown.length > 0) {
        throw new BadRequestError(
          `Unknown permission key(s): ${unknown.join(", ")}`
        );
      }

      desired = new Set(submitted);
      const roleSet = new Set(baseline);
      // Only genuine deltas are stored: a toggle left at its role default writes
      // no row, so it keeps tracking the role matrix instead of freezing today's
      // answer. This is the invariant the whole override model rests on.
      overrideRows = [];
      for (const [key, permissionId] of idByKey) {
        const allow = desired.has(key);
        if (allow !== roleSet.has(key)) {
          overrideRows.push({ permissionId, allow });
        }
      }
    } else {
      // Role-only change: the existing overrides ride onto the new baseline.
      desired = new Set(baseline);
      for (const override of before.overrides) {
        if (override.allow) desired.add(override.key);
        else desired.delete(override.key);
      }
    }

    // The invariant is about the effective permission, never the role: at least
    // one ACTIVE admin must still hold `admins.manage` afterwards. Counting the
    // holders OTHER than the target makes this the post-change state, so it
    // catches both "two SUPER_ADMINs stripped one after the other" and a holder
    // who only has the key via an allow-override on a lesser role.
    if (!desired.has(PERMISSIONS.ADMINS_MANAGE)) {
      const otherHolders = await adminUserRepository.countActiveWithPermission(
        PERMISSIONS.ADMINS_MANAGE,
        id
      );
      if (otherHolders === 0) {
        throw new ConflictError("ADMIN_CANNOT_DEMOTE_LAST_SUPER_ADMIN");
      }
    }

    const updated = role
      ? await adminUserRepository.updateRole(id, role.id)
      : existing;
    if (overrideRows) {
      await rbacService.replaceOverridesForAdmin(id, overrideRows);
    }
    // The cache key carries neither the role nor the overrides, so every write drops it.
    await invalidateAdminPermissions(id);

    const after = await buildPermissionsView(updated);

    // The target's panel re-reads GET /me on this, so its sidebar and page gates
    // follow the new set without a re-login.
    await publishAdminSocketEvent(id, "admin:permissions:updated", {
      adminId: id,
    });

    await auditService.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.ADMIN_PERMISSIONS_UPDATED,
      targetType: "admin",
      targetId: id,
      before: { role: existing.role.key, permissions: before.permissions },
      after: { role: updated.role.key, permissions: after.permissions },
      ip: ctx.ip,
      userAgent: ctx.userAgent ?? null,
    });

    return after;
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
