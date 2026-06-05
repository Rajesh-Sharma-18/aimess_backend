import { prisma } from "../config/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";

export type AuditLogInput = {
  actorId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  ip?: string | null;
  userAgent?: string | null;
};

export const auditLogRepository = {
  /**
   * Append an audit row. Accepts an optional transaction client so the write
   * can share a transaction with the domain mutation it records.
   */
  create(input: AuditLogInput, client: Prisma.TransactionClient = prisma) {
    return client.auditLog.create({
      data: {
        actorId: input.actorId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        ...(input.before !== undefined ? { before: input.before } : {}),
        ...(input.after !== undefined ? { after: input.after } : {}),
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  },
};
