import { prisma } from "../config/prisma.js";
import type { AdminStatus, RoleKey } from "../generated/prisma/client.js";

export const adminUserRepository = {
  /** Lookup for login — includes the role (key needed for JWT claims). */
  findByEmail(email: string) {
    return prisma.adminUser.findUnique({
      where: { email },
      include: { role: true },
    });
  },

  findById(id: string) {
    return prisma.adminUser.findUnique({
      where: { id },
      include: { role: true },
    });
  },

  updateLastLogin(id: string) {
    return prisma.adminUser.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  },

  updatePasswordHash(id: string, passwordHash: string) {
    return prisma.adminUser.update({
      where: { id },
      data: { passwordHash },
    });
  },

  createAdmin(input: {
    email: string;
    passwordHash: string;
    name: string;
    roleId: string;
    status?: AdminStatus;
  }) {
    return prisma.adminUser.create({
      data: {
        email: input.email,
        passwordHash: input.passwordHash,
        name: input.name,
        roleId: input.roleId,
        status: input.status,
      },
      include: { role: true },
    });
  },

  setStatus(id: string, status: AdminStatus) {
    return prisma.adminUser.update({
      where: { id },
      data: { status },
    });
  },

  updateRole(id: string, roleId: string) {
    return prisma.adminUser.update({
      where: { id },
      data: { roleId },
      include: { role: true },
    });
  },

  /** Used by the seed to find a role id by its key. */
  findRoleByKey(key: RoleKey) {
    return prisma.adminRole.findUnique({ where: { key } });
  },
};
