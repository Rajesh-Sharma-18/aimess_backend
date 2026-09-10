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
   * Apply an administrator's change to ONE existing row.
   *
   * A priority change is a REORDER, not a plain field write: the target is
   * moved into the requested slot and the whole catalogue is renumbered
   * 1..N in ONE transaction. That is what keeps the stored ordering free of
   * duplicates and gaps no matter what an admin types — two rows can never end
   * up sharing a priority, because no single write ever sets one in isolation.
   *
   * `null` when the id is not one of the seeded categories: the target row is
   * read before anything is written, so a write can never create a category.
   */
  async updateConfig(
    id: string,
    changes: {
      priority?: number;
      enabledPlatforms?: NotificationPlatform[];
      updatedBy?: string | null;
    }
  ): Promise<NotificationCategoryConfig | null> {
    const rows = await this.listAll();
    const target = rows.find((row) => row.id === id);
    if (!target) return null;

    // id → the new priority it has to be written with. Only rows that actually
    // move are in here; an unchanged row is not rewritten.
    const moved = new Map<string, number>();
    if (changes.priority !== undefined) {
      const ordered = rows.filter((row) => row.id !== id);
      // Clamped defensively — the service rejects an out-of-range priority
      // before this point, so this only guards a future second caller.
      const slot = Math.min(Math.max(changes.priority, 1), rows.length);
      ordered.splice(slot - 1, 0, target);
      ordered.forEach((row, index) => {
        if (row.priority !== index + 1) moved.set(row.id, index + 1);
      });
    }

    const writes = [...moved]
      .filter(([rowId]) => rowId !== id)
      .map(([rowId, priority]) =>
        this.prisma.notificationCategoryConfig.update({
          where: { id: rowId },
          data: { priority },
        })
      );
    // The target is written last so its row is the transaction's final result.
    writes.push(
      this.prisma.notificationCategoryConfig.update({
        where: { id },
        data: {
          ...(moved.has(id) ? { priority: moved.get(id) } : {}),
          ...(changes.enabledPlatforms !== undefined
            ? { enabledPlatforms: changes.enabledPlatforms }
            : {}),
          updatedBy: changes.updatedBy ?? null,
        },
      })
    );

    const results = await this.prisma.$transaction(writes);
    return results[results.length - 1] ?? null;
  }
}
