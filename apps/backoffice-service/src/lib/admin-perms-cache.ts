import { redis } from "../config/redis.js";
import type { RoleKey } from "../generated/prisma/client.js";
import { rbacService } from "../services/rbac.service.js";

const ADMIN_PERMS_PREFIX = "aimess:admin:perms:";
const ADMIN_PERMS_TTL_SECONDS = 60;

// Keyed by admin only — the value is per-admin (role baseline + overrides), so
// folding roleKey into the key would make it a lie the moment either changes.
function permsKey(adminId: string): string {
  return `${ADMIN_PERMS_PREFIX}${adminId}`;
}

/**
 * Resolve an admin's effective permission keys per-request with a short Redis
 * cache (60s TTL). On any Redis error, fall back to a direct RBAC lookup.
 */
export async function getCachedAdminPermissions(
  adminId: string,
  roleKey: RoleKey
): Promise<string[]> {
  try {
    const cached = await redis.get(permsKey(adminId));
    if (cached) {
      return JSON.parse(cached) as string[];
    }
    const permissions = await rbacService.getPermissionKeysForAdmin(
      adminId,
      roleKey
    );
    await redis.set(
      permsKey(adminId),
      JSON.stringify(permissions),
      "EX",
      ADMIN_PERMS_TTL_SECONDS
    );
    return permissions;
  } catch {
    return rbacService.getPermissionKeysForAdmin(adminId, roleKey);
  }
}

/**
 * Drop the cached set after a role change or an override edit. Swallows Redis
 * errors — a failed invalidation costs at most one TTL of staleness and must
 * never throw into the request that made the change.
 */
export async function invalidateAdminPermissions(
  adminId: string
): Promise<void> {
  try {
    await redis.del(permsKey(adminId));
  } catch {
    // Stale for at most ADMIN_PERMS_TTL_SECONDS.
  }
}
