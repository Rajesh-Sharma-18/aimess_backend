/**
 * Priority is the catalogue's render order, and the ONLY ordering the clients
 * have. Two rules have to hold no matter what an administrator types:
 *
 *  - a priority outside 1..N (N = the fixed catalogue size) is refused by the
 *    service, which owns the rows — not only by the panel's request schema, so
 *    a direct API call cannot bypass it;
 *  - a priority another row already holds is a REORDER, and the stored result
 *    is renumbered 1..N: unique, continuous, no gaps.
 */
import { NotificationCategoryRepository } from "../../src/repositories/notification-category.repository.js";
import { NotificationCatalogueService } from "../../src/services/notification-catalogue.service.js";
import { NOTIFICATION_CATEGORY_SEED } from "../../src/lib/notification-category.js";

type Row = {
  id: string;
  priority: number;
  defaultLabel: string;
  iconKey: string;
  enabledPlatforms: string[];
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const AT = new Date("2026-09-09T10:00:00Z");

function seededRows(): Row[] {
  return NOTIFICATION_CATEGORY_SEED.map((c) => ({
    id: c.id,
    priority: c.priority,
    defaultLabel: c.defaultLabel,
    iconKey: c.iconKey,
    enabledPlatforms: [...c.enabledPlatforms],
    updatedBy: null,
    createdAt: AT,
    updatedAt: AT,
  }));
}

/** Enough of the Prisma client for the reorder: findMany, update, $transaction. */
function fakePrisma(rows: Row[]) {
  const store = rows;
  const transactions: number[] = [];
  return {
    store,
    transactions,
    prisma: {
      notificationCategoryConfig: {
        findMany: () =>
          Promise.resolve(
            [...store].sort(
              (a, b) => a.priority - b.priority || a.id.localeCompare(b.id)
            )
          ),
        update: ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<Row>;
        }) => {
          const target = store.find((r) => r.id === where.id)!;
          Object.assign(target, data);
          return Promise.resolve(target);
        },
      },
      $transaction: (writes: Promise<Row>[]) => {
        transactions.push(writes.length);
        return Promise.all(writes);
      },
    },
  };
}

function priorities(store: Row[]): [string, number][] {
  return [...store]
    .sort((a, b) => a.priority - b.priority)
    .map((r) => [r.id, r.priority] as [string, number]);
}

describe("notification category priority", () => {
  describe("reorder", () => {
    it("moves CALLS to 1 and renumbers the rest 1..6 with no duplicate and no gap", async () => {
      const { prisma, store, transactions } = fakePrisma(seededRows());
      const repo = new NotificationCategoryRepository(prisma as never);

      const updated = await repo.updateConfig("CALLS", {
        priority: 1,
        updatedBy: "admin-1",
      });

      expect(updated?.priority).toBe(1);
      expect(priorities(store)).toEqual([
        ["CALLS", 1],
        ["FRIEND_REQUEST", 2],
        ["COMMUNITY", 3],
        ["MENTION", 4],
        ["SYSTEM", 5],
        ["LIVE_NOW", 6],
      ]);
      // Every row that moved is written in ONE transaction — a concurrent
      // admin edit can never observe a half-renumbered catalogue.
      expect(transactions).toEqual([4]);
    });

    it("moves a category down and closes the gap it left behind", async () => {
      const { prisma, store } = fakePrisma(seededRows());
      const repo = new NotificationCategoryRepository(prisma as never);

      await repo.updateConfig("FRIEND_REQUEST", { priority: 6 });

      expect(priorities(store)).toEqual([
        ["COMMUNITY", 1],
        ["MENTION", 2],
        ["CALLS", 3],
        ["SYSTEM", 4],
        ["LIVE_NOW", 5],
        ["FRIEND_REQUEST", 6],
      ]);
    });

    it("writes only the target when the priority is unchanged", async () => {
      const { prisma, store, transactions } = fakePrisma(seededRows());
      const repo = new NotificationCategoryRepository(prisma as never);

      await repo.updateConfig("COMMUNITY", { priority: 2 });

      expect(transactions).toEqual([1]);
      expect(priorities(store).map(([id]) => id)).toEqual(
        NOTIFICATION_CATEGORY_SEED.map((c) => c.id)
      );
    });

    it("leaves the order alone for a platform-only change", async () => {
      const { prisma, store } = fakePrisma(seededRows());
      const repo = new NotificationCategoryRepository(prisma as never);

      const updated = await repo.updateConfig("CALLS", {
        enabledPlatforms: ["ANDROID"],
      });

      expect(updated?.enabledPlatforms).toEqual(["ANDROID"]);
      expect(priorities(store)).toEqual(
        NOTIFICATION_CATEGORY_SEED.map((c) => [c.id, c.priority])
      );
    });

    it("never creates a row for an id outside the catalogue", async () => {
      const { prisma, store } = fakePrisma(seededRows());
      const repo = new NotificationCategoryRepository(prisma as never);

      await expect(repo.updateConfig("NOPE", { priority: 1 })).resolves.toBeNull();
      expect(store).toHaveLength(6);
    });
  });

  describe("service validation", () => {
    function service(rows: Row[]) {
      const { prisma, store } = fakePrisma(rows);
      return {
        store,
        service: new NotificationCatalogueService(
          new NotificationCategoryRepository(prisma as never)
        ),
      };
    }

    it.each([0, -1, -5, 7, 100, 1.5, Number.NaN])(
      "rejects priority %p without writing anything",
      async (priority) => {
        const { service: svc, store } = service(seededRows());

        await expect(
          svc.updateCategory("CALLS", { priority }, "admin-1")
        ).rejects.toMatchObject({
          statusCode: 400,
          messageKey: "NOTIFICATION_CATEGORY_PRIORITY_INVALID",
        });
        expect(priorities(store)).toEqual(
          NOTIFICATION_CATEGORY_SEED.map((c) => [c.id, c.priority])
        );
      }
    );

    it.each([1, 3, 6])("accepts priority %p", async (priority) => {
      const { service: svc } = service(seededRows());

      const updated = await svc.updateCategory("CALLS", { priority }, "admin-1");

      expect(updated?.priority).toBe(priority);
    });

    it("reports an unknown id as null rather than a validation error", async () => {
      const { service: svc } = service(seededRows());

      await expect(
        svc.updateCategory("NOPE", { priority: 1 }, "admin-1")
      ).resolves.toBeNull();
    });
  });
});

/**
 * The Super Admin grid's Save: the administrator's whole draft in one call.
 *
 * The rule the single-row path cannot express lives here — priorities are
 * judged on the FINAL state of the catalogue, so a swap and a collision stop
 * looking the same. Every rejection below must also leave the stored rows
 * untouched: a refused draft is not a partially applied one.
 */
describe("notification category bulk save", () => {
  function service(rows: Row[]) {
    const { prisma, store, transactions } = fakePrisma(rows);
    return {
      store,
      transactions,
      service: new NotificationCatalogueService(
        new NotificationCategoryRepository(prisma as never)
      ),
    };
  }

  const SEEDED = NOTIFICATION_CATEGORY_SEED.map(
    (c) => [c.id, c.priority] as [string, number]
  );

  it("saves a 1<->2 swap atomically instead of calling it a conflict", async () => {
    const { service: svc, store, transactions } = service(seededRows());

    const saved = await svc.updateCategories(
      [
        { id: "FRIEND_REQUEST", priority: 2 },
        { id: "COMMUNITY", priority: 1 },
      ],
      "admin-1"
    );

    expect(priorities(store)).toEqual([
      ["COMMUNITY", 1],
      ["FRIEND_REQUEST", 2],
      ["MENTION", 3],
      ["CALLS", 4],
      ["SYSTEM", 5],
      ["LIVE_NOW", 6],
    ]);
    // Both rows in ONE transaction: the duplicate that exists between the two
    // writes is never a state anyone can read.
    expect(transactions).toEqual([2]);
    expect(saved?.map((c) => c.id)).toEqual([
      "COMMUNITY",
      "FRIEND_REQUEST",
      "MENTION",
      "CALLS",
      "SYSTEM",
      "LIVE_NOW",
    ]);
  });

  it("rejects a half-swap that would leave two categories on priority 1", async () => {
    const { service: svc, store, transactions } = service(seededRows());

    await expect(
      svc.updateCategories([{ id: "COMMUNITY", priority: 1 }], "admin-1")
    ).rejects.toMatchObject({
      statusCode: 400,
      messageKey: "NOTIFICATION_CATEGORY_PRIORITY_CONFLICT",
    });
    // Nothing written, and — unlike the single-row path — no other row was
    // pushed aside to make the requested number fit.
    expect(priorities(store)).toEqual(SEEDED);
    expect(transactions).toEqual([]);
  });

  it("rejects two rows in the same draft asking for the same priority", async () => {
    const { service: svc, store } = service(seededRows());

    await expect(
      svc.updateCategories(
        [
          { id: "CALLS", priority: 3 },
          { id: "MENTION", priority: 3 },
        ],
        "admin-1"
      )
    ).rejects.toMatchObject({
      messageKey: "NOTIFICATION_CATEGORY_PRIORITY_CONFLICT",
    });
    expect(priorities(store)).toEqual(SEEDED);
  });

  it.each([0, -1, 7, 1.5, Number.NaN])(
    "rejects priority %p and writes nothing, even when another row in the draft is valid",
    async (priority) => {
      const { service: svc, store, transactions } = service(seededRows());

      await expect(
        svc.updateCategories(
          [
            { id: "CALLS", enabledPlatforms: ["ANDROID"] },
            { id: "MENTION", priority },
          ],
          "admin-1"
        )
      ).rejects.toMatchObject({
        statusCode: 400,
        messageKey: "NOTIFICATION_CATEGORY_PRIORITY_INVALID",
      });
      expect(priorities(store)).toEqual(SEEDED);
      expect(store.find((r) => r.id === "CALLS")?.enabledPlatforms).toEqual([
        "ANDROID",
        "IOS",
        "WEB",
      ]);
      expect(transactions).toEqual([]);
    }
  );

  it("never creates a row, and writes nothing, for an id outside the catalogue", async () => {
    const { service: svc, store, transactions } = service(seededRows());

    await expect(
      svc.updateCategories(
        [
          { id: "CALLS", priority: 1 },
          { id: "NOPE", priority: 2 },
        ],
        "admin-1"
      )
    ).resolves.toBeNull();
    expect(store).toHaveLength(6);
    expect(priorities(store)).toEqual(SEEDED);
    expect(transactions).toEqual([]);
  });

  it("persists several platform changes together and leaves the order alone", async () => {
    const { service: svc, store } = service(seededRows());

    await svc.updateCategories(
      [
        { id: "CALLS", enabledPlatforms: ["ANDROID", "IOS"] },
        { id: "SYSTEM", enabledPlatforms: [] },
      ],
      "admin-1"
    );

    // Dropping WEB from one category touches neither the other platforms of
    // that row nor any other row.
    expect(store.find((r) => r.id === "CALLS")?.enabledPlatforms).toEqual([
      "ANDROID",
      "IOS",
    ]);
    expect(store.find((r) => r.id === "SYSTEM")?.enabledPlatforms).toEqual([]);
    expect(store.find((r) => r.id === "MENTION")?.enabledPlatforms).toEqual([
      "ANDROID",
      "IOS",
      "WEB",
    ]);
    expect(priorities(store)).toEqual(SEEDED);
  });

  it("leaves a row's priority alone when only its platforms are submitted", async () => {
    const { service: svc, store } = service(seededRows());

    await svc.updateCategories(
      [{ id: "FRIEND_REQUEST", enabledPlatforms: ["WEB"] }],
      "admin-1"
    );

    expect(priorities(store)).toEqual(SEEDED);
  });
});
