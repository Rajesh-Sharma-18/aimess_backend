import { redis } from "../config/redis.js";
import type { RoleKey } from "../generated/prisma/client.js";
import { rbacService } from "../services/rbac.service.js";

const ADMIN_PERMS_PREFIX = "aimess:admin:perms:";
const ADMIN_PERMS_TTL_SECONDS = 60;

function permsKey(adminId: string, roleKey: RoleKey): string {
  return `${ADMIN_PERMS_PREFIX}${adminId}:${roleKey}`;
}

/**
 * Resolve an admin's permission keys per-request with a short Redis cache
 * (60s TTL). On any Redis error, fall back to a direct RBAC lookup.
 */
export async function getCachedAdminPermissions(
  adminId: string,
  roleKey: RoleKey
): Promise<string[]> {
  try {
    const cached = await redis.get(permsKey(adminId, roleKey));
    if (cached) {
      return JSON.parse(cached) as string[];
    }
    const permissions = await rbacService.getPermissionKeysForRole(roleKey);
    await redis.set(
      permsKey(adminId, roleKey),
      JSON.stringify(permissions),
      "EX",
      ADMIN_PERMS_TTL_SECONDS
    );
    return permissions;
  } catch {
    return rbacService.getPermissionKeysForRole(roleKey);
  }
}
