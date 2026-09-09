import { createHash } from "node:crypto";

import { logger } from "@aimess/logger";

import type { NotificationCategoryRepository } from "../repositories/notification-category.repository.js";
import {
  NOTIFICATION_CATEGORY_SEED,
  type NotificationCategoryId,
  type NotificationPlatform,
} from "../lib/notification-category.js";

/** One catalogue entry as clients receive it. */
export interface NotificationCategoryDTO {
  id: string;
  priority: number;
  defaultLabel: string;
  iconKey: string;
}

/** The catalogue for one platform, plus the metadata clients cache it against. */
export interface NotificationCatalogue {
  categories: NotificationCategoryDTO[];
  /**
   * Changes exactly when this platform's catalogue changes, and not otherwise.
   * A content hash rather than a counter: a counter has to be stored, bumped by
   * every writer and kept per-platform, and any writer that forgets leaves
   * clients pinned to a stale cache. Hashing the payload cannot forget.
   *
   * Same version → the client keeps what it has. New version → it replaces it.
   */
  version: string;
  /** Most recent configuration change, across all platforms. Informational. */
  updatedAt: string | null;
}

/** One catalogue row as Super Admin sees it — every platform, not just one. */
export interface NotificationCategoryAdminDTO extends NotificationCategoryDTO {
  enabledPlatforms: NotificationPlatform[];
  updatedAt: string;
}

/** How long a catalogue read is trusted before re-checking the database. */
const CACHE_TTL_MS = 30_000;

/**
 * Serves the fixed notification-category catalogue.
 *
 * The read sits behind every client's Notification Center, so it is cached
 * in-process on a short TTL — the same shape as `CallFlagService`, and for the
 * same reason: an admin switch does not need to be instant, and a per-node TTL
 * is far less machinery than a cross-node invalidation bus. A write through
 * THIS service clears the local cache immediately; other nodes converge within
 * `CACHE_TTL_MS`. Clients pick the change up on their next catalogue fetch —
 * which is what the Super Admin screen tells the administrator.
 *
 * ponytail: per-node cache, no invalidation fan-out. If a toggle ever needs to
 * be instant across nodes, publish an invalidation on the existing Redis bus.
 */
export class NotificationCatalogueService {
  private cache = new Map<
    NotificationPlatform,
    { value: NotificationCatalogue; at: number }
  >();

  constructor(private readonly repo: NotificationCategoryRepository) {}

  /**
   * The catalogue for one platform: categories enabled there, priority-ordered,
   * with the version/updatedAt a client revalidates against. `ALL` is never in
   * it — that is the client's own no-filter state.
   *
   * Falls back to the compiled-in seed if the collection is empty or unreadable.
   * An unseeded environment or a transient database error must not hand clients
   * an empty chip row; the seed values are the same ones the seed script writes.
   */
  async getCatalogue(
    platform: NotificationPlatform
  ): Promise<NotificationCatalogue> {
    const now = Date.now();
    const hit = this.cache.get(platform);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;

    let value: NotificationCatalogue;
    try {
      const rows = await this.repo.listAll();
      value = rows.length
        ? buildCatalogue(
            rows
              .filter((row) =>
                (row.enabledPlatforms as string[]).includes(platform)
              )
              .map((row) => ({
                id: row.id,
                priority: row.priority,
                defaultLabel: row.defaultLabel,
                iconKey: row.iconKey,
              })),
            rows.reduce<Date | null>(
              (latest, row) =>
                !latest || row.updatedAt > latest ? row.updatedAt : latest,
              null
            )
          )
        : seedCatalogue(platform);
    } catch (error) {
      logger.warn(
        `NotificationCatalogueService|read failed, serving seed defaults: ${String(error)}`
      );
      return seedCatalogue(platform);
    }

    this.cache.set(platform, { value, at: now });
    return value;
  }

  /** Every row with its full platform state — the Super Admin grid. */
  async listForAdmin(): Promise<NotificationCategoryAdminDTO[]> {
    const rows = await this.repo.listAll();
    return rows.map((row) => ({
      id: row.id,
      priority: row.priority,
      defaultLabel: row.defaultLabel,
      iconKey: row.iconKey,
      enabledPlatforms: row.enabledPlatforms as NotificationPlatform[],
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /**
   * Apply an administrator's change. Only `priority` and `enabledPlatforms` are
   * writable — the id, label and icon key are code. `null` when the id is not
   * one of the seeded categories, which the caller reports as a 404 rather than
   * creating anything.
   */
  async updateCategory(
    id: string,
    changes: {
      priority?: number;
      enabledPlatforms?: NotificationPlatform[];
    },
    actorId?: string | null
  ): Promise<NotificationCategoryAdminDTO | null> {
    const row = await this.repo.updateConfig(id, {
      ...changes,
      updatedBy: actorId ?? null,
    });
    if (!row) return null;
    // Every platform's payload can shift when one row moves (priority reorders
    // the whole list), so drop the lot rather than guessing which are stale.
    this.cache.clear();
    logger.info(
      `NotificationCatalogueService|${row.id} updated by ${row.updatedBy ?? "unknown"} — priority ${String(row.priority)}, platforms [${row.enabledPlatforms.join(", ")}]`
    );
    return {
      id: row.id,
      priority: row.priority,
      defaultLabel: row.defaultLabel,
      iconKey: row.iconKey,
      enabledPlatforms: row.enabledPlatforms as NotificationPlatform[],
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/** Hash the payload a client would cache — never the timestamp around it. */
function buildCatalogue(
  categories: NotificationCategoryDTO[],
  updatedAt: Date | null
): NotificationCatalogue {
  const sorted = [...categories].sort(
    (a, b) => a.priority - b.priority || a.id.localeCompare(b.id)
  );
  const version = createHash("sha256")
    .update(JSON.stringify(sorted))
    .digest("hex")
    .slice(0, 16);
  return {
    categories: sorted,
    version,
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
  };
}

/** The compiled-in catalogue, used when the collection has not been seeded. */
function seedCatalogue(platform: NotificationPlatform): NotificationCatalogue {
  return buildCatalogue(
    NOTIFICATION_CATEGORY_SEED.filter((c) =>
      c.enabledPlatforms.includes(platform)
    ).map((c) => ({
      id: c.id satisfies NotificationCategoryId,
      priority: c.priority,
      defaultLabel: c.defaultLabel,
      iconKey: c.iconKey,
    })),
    null
  );
}
