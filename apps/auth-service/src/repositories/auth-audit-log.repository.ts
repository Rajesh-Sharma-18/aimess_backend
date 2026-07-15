import { prisma } from "../config/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";

export type AuthAuditLogInput = {
  userId?: string | null;
  event: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
};

export const authAuditLogRepository = {
  /** Append-only insert — see AuthAuditLog in schema.prisma for why this is a
   * separate table from backoffice's admin-only AuditLog. */
  create(input: AuthAuditLogInput) {
    return prisma.authAuditLog.create({
      data: {
        userId: input.userId ?? null,
        event: input.event,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
        ipAddress: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  },
};
