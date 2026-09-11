import { PrismaClient } from "../../src/generated/prisma/index.js";
import { NOTIFICATION_CATEGORY_SEED } from "../../src/lib/notification-category.js";

// The datasource URL is resolved the same way the service resolves it, rather
// than left to `env("MONGO_DATABASE_URL")` in the schema: only the MONGO_* parts
// are in .env, so the bare env var is undefined under `tsx` and Prisma fails
// validation before the first query. Imported lazily inside the direct-run
// block so the Jest suite can import the seed function without a real .env.

/** The subset of PrismaClient the seed touches, so a test can stand it in. */
export interface NotificationCategorySeedClient {
  notificationCategoryConfig: {
    findUnique(args: {
      where: { id: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
    update(args: {
      where: { id: string };
      data: { defaultLabel: string; iconKey: string };
    }): Promise<unknown>;
    create(args: {
      data: {
        id: string;
        priority: number;
        defaultLabel: string;
        iconKey: string;
        enabledPlatforms: string[];
      };
    }): Promise<unknown>;
  };
}

/**
 * Seeds the SIX fixed notification categories. Run via `pnpm db:seed`, and safe
 * to run on every deployment.
 *
 * Idempotent by construction: `_id` is the stable catalogue id, so a re-run
 * finds the existing row instead of inserting a second one — there is no
 * generated key that could produce a duplicate.
 *
 * A re-run also does NOT overwrite an administrator's configuration. `priority`
 * and `enabledPlatforms` are theirs to set from Super Admin, and a deploy that
 * reset "CALLS is off for Web" back to the seed default would silently undo a
 * deliberate decision. Only `defaultLabel` and `iconKey` — which are code, not
 * configuration — are kept in sync on an existing row.
 *
 * NOTE: the local Mongo runs as a STANDALONE node (no replica set), so Prisma
 * `upsert` — which it implements via a transaction on Mongo — fails with P2031.
 * Seed with a non-transactional find → update/create by id instead, the same
 * way community-service's category seed does.
 */
export async function seedNotificationCategories(
  prisma: NotificationCategorySeedClient
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  for (const category of NOTIFICATION_CATEGORY_SEED) {
    const existing = await prisma.notificationCategoryConfig.findUnique({
      where: { id: category.id },
      select: { id: true },
    });

    if (existing) {
      await prisma.notificationCategoryConfig.update({
        where: { id: category.id },
        data: {
          defaultLabel: category.defaultLabel,
          iconKey: category.iconKey,
        },
      });
      updated += 1;
    } else {
      await prisma.notificationCategoryConfig.create({
        data: {
          id: category.id,
          priority: category.priority,
          defaultLabel: category.defaultLabel,
          iconKey: category.iconKey,
          enabledPlatforms: [...category.enabledPlatforms],
        },
      });
      created += 1;
    }
  }

  return { created, updated };
}

/**
 * `tsx prisma/seed/…` runs this file directly; the Jest suite imports
 * `seedNotificationCategories` above and never reaches here. Guarded on
 * `process.argv` rather than an `import.meta` check so the module stays
 * importable under ts-jest's CommonJS transform.
 */
const isDirectRun = process.argv[1]?.includes("notification-categories.seed");

if (isDirectRun) {
  // Dynamic import, not top level: `await` at module scope would break the
  // Jest suite that imports this file under the CommonJS transform.
  void import("../../src/config/env.js")
    .then(async ({ env }) => {
      const prisma = new PrismaClient({
        datasourceUrl: env.MONGO_DATABASE_URL,
      });
      try {
        const { created, updated } = await seedNotificationCategories(prisma);
        // eslint-disable-next-line no-console
        console.log(
          `Notification categories seeded — ${String(created)} created, ${String(updated)} already present.`
        );
      } finally {
        await prisma.$disconnect();
      }
    })
    .catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(error);
      process.exit(1);
    });
}
