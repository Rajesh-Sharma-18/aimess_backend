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

  /** Offset-paginated, most-recent-first moderation-action rows for a report. */
  async listByReportId(reportId: string, skip: number, take: number) {
    const [total, rows] = await Promise.all([
      prisma.moderationAction.count({ where: { reportId } }),
      prisma.moderationAction.findMany({
        where: { reportId },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
    ]);
    return { total, rows };
  },

  /**
   * The latest ban_user/suspend_user action per target, for a batch of
   * targets — resolves "who currently holds this user's active restriction"
   * (`bannedBy`) for a whole page of users in ONE query instead of N. Uses
   * `distinct` + a matching `orderBy` so only the newest row per `targetId`
   * survives. A target absent from the result has no recorded ban/suspend
   * action (never restricted, or restricted by a path outside this table).
   */
  async latestBanActionsByTargets(
    targetIds: string[]
  ): Promise<Map<string, { actorId: string; createdAt: Date }>> {
    if (targetIds.length === 0) return new Map();
    const rows = await prisma.moderationAction.findMany({
      where: {
        targetType: "user",
        targetId: { in: targetIds },
        type: { in: ["ban_user", "suspend_user"] },
      },
      orderBy: [{ targetId: "asc" }, { createdAt: "desc" }],
      distinct: ["targetId"],
      select: { targetId: true, actorId: true, createdAt: true },
    });
    return new Map(rows.map((r) => [r.targetId, r]));
  },
};
