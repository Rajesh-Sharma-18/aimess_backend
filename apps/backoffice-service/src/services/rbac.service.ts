import type { RoleKey } from "../generated/prisma/client.js";
import { rbacRepository } from "../repositories/index.js";

export const rbacService = {
  getPermissionKeysForRole(roleKey: RoleKey): Promise<string[]> {
    return rbacRepository.getPermissionKeysForRole(roleKey);
  },

  getPermissionKeysForAdmin(
    adminId: string,
    roleKey: RoleKey
  ): Promise<string[]> {
    return rbacRepository.getPermissionKeysForAdmin(adminId, roleKey);
  },

  listOverridesForAdmin(adminId: string) {
    return rbacRepository.listOverridesForAdmin(adminId);
  },

  replaceOverridesForAdmin(
    adminId: string,
    rows: { permissionId: string; allow: boolean }[]
  ): Promise<void> {
    return rbacRepository.replaceOverridesForAdmin(adminId, rows);
  },

  findPermissionsByKeys(keys: string[]) {
    return rbacRepository.findPermissionsByKeys(keys);
  },

  listRoles() {
    return rbacRepository.listRoles();
  },

  listPermissions() {
    return rbacRepository.listPermissions();
  },
};
