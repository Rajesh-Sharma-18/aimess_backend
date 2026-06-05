import type { RoleKey } from "../generated/prisma/client.js";
import { rbacRepository } from "../repositories/index.js";

export const rbacService = {
  getPermissionKeysForRole(roleKey: RoleKey): Promise<string[]> {
    return rbacRepository.getPermissionKeysForRole(roleKey);
  },

  listRoles() {
    return rbacRepository.listRoles();
  },

  listPermissions() {
    return rbacRepository.listPermissions();
  },
};
