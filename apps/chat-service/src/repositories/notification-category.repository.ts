import type {
  NotificationCategoryConfig,
  PrismaClient,
} from "../generated/prisma/index.js";
import type { NotificationPlatform } from "../lib/notification-category.js";

/**
 * The fixed notification-category catalogue (see `NotificationCategoryConfig`
 * in prisma/schema.prisma).
 *
 * READ-ONLY apart from the two fields an administrator owns. There is
 * deliberately no `create` and no `delete` here: the six rows are seeded, their
 * ids are the persisted client contract, and the absence of those methods is
 * what makes "no category creation / no category deletion" a property of the
 * code rather than a rule someone has to remember at the route layer.
 */
export class NotificationCategoryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Every row, priority-ordered. Ties break on id so the order is total. */
  listAll(): Promise<NotificationCategoryConfig[]> {
    return this.prisma.notificationCategoryConfig.findMany({
      orderBy: [{ priority: "asc" }, { id: "asc" }],
    });
  }

  /** Rows the chip row should show on one platform, priority-ordered. */
  listForPlatform(
    platform: NotificationPlatform
  ): Promise<NotificationCategoryConfig[]> {
    return this.prisma.notificationCategoryConfig.findMany({
      where: { enabledPlatforms: { has: platform } },
      orderBy: [{ priority: "asc" }, { id: "asc" }],
    });
  }

  findById(id: string): Promise<NotificationCategoryConfig | null> {
    return this.prisma.notificationCategoryConfig.findUnique({ where: { id } });
  }

  /**
   * Apply an administrator's change to ONE existing row. `updateMany` scoped to
   * the id (rather than `update`) so an unknown id changes nothing and reports
   * `0` instead of throwing — the caller turns that into a 404, and a category
   * can never be conjured into existence by a write.
   */
  async updateConfig(
    id: string,
    changes: {
      priority?: number;
      enabledPlatforms?: NotificationPlatform[];
      updatedBy?: string | null;
    }
  ): Promise<NotificationCategoryConfig | null> {
    const result = await this.prisma.notificationCategoryConfig.updateMany({
      where: { id },
      data: {
        ...(changes.priority !== undefined
          ? { priority: changes.priority }
          : {}),
        ...(changes.enabledPlatforms !== undefined
          ? { enabledPlatforms: changes.enabledPlatforms }
          : {}),
        updatedBy: changes.updatedBy ?? null,
      },
    });
    if (result.count === 0) return null;
    return this.findById(id);
  }
}
