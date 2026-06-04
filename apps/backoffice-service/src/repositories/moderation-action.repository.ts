import { prisma } from "../config/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";

export type ModerationActionInput = {
  actorId: string;
  /** ban_user | suspend_user | suspend_community | reopen_community | delete_content | force_end_stream */
  type: string;
  targetType: string;
  targetId: string;
  reason: string;
  metadata?: Prisma.InputJsonValue;
  reportId?: string | null;
  expiresAt?: Date | null;
};

export const moderationActionRepository = {
  /**
   * Append a moderation-action row. Accepts an optional transaction client so the
   * write can share a transaction with the domain mutation it records.
   */
  create(
    input: ModerationActionInput,
    client: Prisma.TransactionClient = prisma
  ) {
    return client.moderationAction.create({
      data: {
        actorId: input.actorId,
        type: input.type,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: input.reason,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        reportId: input.reportId ?? null,
        expiresAt: input.expiresAt ?? null,
      },
    });
  },

  /**
   * Most-recent-first moderation-action rows for a given target. Used by the
   * gRPC-backed community repository to compose moderationHistory from admin_db
   * (community-service does not own these rows).
   */
  listByTarget(targetType: string, targetId: string, limit: number) {
    return prisma.moderationAction.findMany({
      where: { targetType, targetId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  },
};
