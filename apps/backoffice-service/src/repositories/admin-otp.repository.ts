import { prisma } from "../config/prisma.js";
import {
  AdminOtpPurpose,
  type AdminOtpCode,
} from "../generated/prisma/client.js";

export const adminOtpRepository = {
  consumeActiveForIdentifier(identifier: string, purpose: AdminOtpPurpose) {
    return prisma.adminOtpCode.updateMany({
      where: {
        identifier,
        purpose,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });
  },

  create(params: {
    adminId: string;
    identifier: string;
    purpose: AdminOtpPurpose;
    codeHash: string;
    expiresAt: Date;
    ip?: string | null;
    maxAttempts: number;
  }): Promise<AdminOtpCode> {
    return prisma.adminOtpCode.create({
      data: {
        adminId: params.adminId,
        identifier: params.identifier,
        purpose: params.purpose,
        codeHash: params.codeHash,
        maxAttempts: params.maxAttempts,
        expiresAt: params.expiresAt,
        ip: params.ip ?? undefined,
      },
    });
  },

  findLatestActive(identifier: string, purpose: AdminOtpPurpose) {
    return prisma.adminOtpCode.findFirst({
      where: {
        identifier,
        purpose,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });
  },

  incrementAttempts(id: string) {
    return prisma.adminOtpCode.update({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
  },

  markConsumed(id: string) {
    return prisma.adminOtpCode.update({
      where: { id },
      data: { consumedAt: new Date() },
    });
  },
};
