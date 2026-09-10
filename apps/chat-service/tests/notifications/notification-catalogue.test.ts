/**
 * The server-driven notification-category catalogue.
 *
 * One response backs the chip row on Android, iOS and Web, so the rules it has
 * to hold are contract rules, not presentation ones: only categories enabled
 * for the requesting platform, sorted by the priority an administrator set,
 * never `ALL`, and a `version` that changes when — and only when — that
 * platform's payload changes.
 */
import { NotificationCatalogueService } from "../../src/services/notification-catalogue.service.js";
import type { NotificationCategoryRepository } from "../../src/repositories/notification-category.repository.js";
import {
  NOTIFICATION_CATEGORY_SEED,
  type NotificationPlatform,
} from "../../src/lib/notification-category.js";

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

function row(overrides: Partial<Row> & { id: string }): Row {
  const seed = NOTIFICATION_CATEGORY_SEED.find((c) => c.id === overrides.id);
  return {
    priority: seed?.priority ?? 99,
    defaultLabel: seed?.defaultLabel ?? overrides.id,
    iconKey: seed?.iconKey ?? "bell",
    enabledPlatforms: [...(seed?.enabledPlatforms ?? ["ANDROID", "IOS", "WEB"])],
    updatedBy: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

/** The seeded catalogue, as the collection would hold it. */
function seededRows(): Row[] {
  return NOTIFICATION_CATEGORY_SEED.map((c) => row({ id: c.id }));
}

function fakeRepo(rows: Row[]) {
  const store = [...rows];
  return {
    store,
    repo: {
      listAll: jest.fn(() =>
        Promise.resolve(
          [...store].sort((a, b) => a.priority - b.priority) as never
        )
      ),
      listForPlatform: jest.fn(),
      findById: jest.fn(),
      updateConfig: jest.fn(
        (
          id: string,
          changes: { priority?: number; enabledPlatforms?: string[] }
        ) => {
          const target = store.find((r) => r.id === id);
          if (!target) return Promise.resolve(null);
          if (changes.priority !== undefined) target.priority = changes.priority;
          if (changes.enabledPlatforms !== undefined)
            target.enabledPlatforms = changes.enabledPlatforms;
          target.updatedAt = new Date(AT.getTime() + 1000);
          return Promise.resolve(target as never);
        }
      ),
    } as unknown as NotificationCategoryRepository,
  };
}

describe("notification category catalogue", () => {
  it("returns the six seeded categories, priority ascending, without ALL", async () => {
    const { repo } = fakeRepo(seededRows());
    const service = new NotificationCatalogueService(repo);

    const { categories } = await service.getCatalogue("ANDROID");

    expect(categories.map((c) => c.id)).toEqual([
      "FRIEND_REQUEST",
      "COMMUNITY",
      "MENTION",
      "CALLS",
      "SYSTEM",
      "LIVE_NOW",
    ]);
    expect(categories.map((c) => c.priority)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(categories.some((c) => c.id === "ALL")).toBe(false);
  });

  it("carries the label and icon key each entry is rendered from", async () => {
    const { repo } = fakeRepo(seededRows());
    const service = new NotificationCatalogueService(repo);

    const { categories } = await service.getCatalogue("WEB");

    expect(categories[0]).toEqual({
      id: "FRIEND_REQUEST",
      priority: 1,
      defaultLabel: "Friend Request",
      iconKey: "person_add",
    });
  });

  it("sorts by the administrator's priority, not by seed order", async () => {
    const rows = seededRows();
    rows.find((r) => r.id === "CALLS")!.priority = 0;
    const { repo } = fakeRepo(rows);
    const service = new NotificationCatalogueService(repo);

    const { categories } = await service.getCatalogue("IOS");

    expect(categories[0].id).toBe("CALLS");
  });

  describe("platform filtering", () => {
    it("drops a category disabled for the requested platform only", async () => {
      const rows = seededRows();
      rows.find((r) => r.id === "CALLS")!.enabledPlatforms = [
        "ANDROID",
        "IOS",
      ];
      const { repo } = fakeRepo(rows);
      const service = new NotificationCatalogueService(repo);

      const web = await service.getCatalogue("WEB");
      const android = await service.getCatalogue("ANDROID");
      const ios = await service.getCatalogue("IOS");

      expect(web.categories.map((c) => c.id)).not.toContain("CALLS");
      expect(android.categories.map((c) => c.id)).toContain("CALLS");
      expect(ios.categories.map((c) => c.id)).toContain("CALLS");
    });

    it("keeps every other category on the platform that lost one", async () => {
      const rows = seededRows();
      rows.find((r) => r.id === "CALLS")!.enabledPlatforms = ["ANDROID", "IOS"];
      const { repo } = fakeRepo(rows);
      const service = new NotificationCatalogueService(repo);

      const { categories } = await service.getCatalogue("WEB");

      expect(categories).toHaveLength(5);
      expect(categories.map((c) => c.priority)).toEqual([1, 2, 3, 5, 6]);
    });

    it("treats the three platforms as independent", async () => {
      const rows = seededRows();
      rows.find((r) => r.id === "CALLS")!.enabledPlatforms = ["ANDROID"];
      rows.find((r) => r.id === "MENTION")!.enabledPlatforms = ["WEB"];
      const { repo } = fakeRepo(rows);
      const service = new NotificationCatalogueService(repo);

      const byPlatform = async (platform: NotificationPlatform) =>
        (await service.getCatalogue(platform)).categories.map((c) => c.id);

      expect(await byPlatform("ANDROID")).toContain("CALLS");
      expect(await byPlatform("IOS")).not.toContain("CALLS");
      expect(await byPlatform("IOS")).not.toContain("MENTION");
      expect(await byPlatform("WEB")).toContain("MENTION");
    });
  });

  describe("version / update metadata", () => {
    it("is stable while nothing changes", async () => {
      const { repo } = fakeRepo(seededRows());
      const a = new NotificationCatalogueService(repo);
      const b = new NotificationCatalogueService(repo);

      expect((await a.getCatalogue("WEB")).version).toBe(
        (await b.getCatalogue("WEB")).version
      );
    });

    it("changes when a category is disabled for that platform", async () => {
      const { store, repo } = fakeRepo(seededRows());
      const service = new NotificationCatalogueService(repo);
      const before = (await service.getCatalogue("WEB")).version;

      await service.updateCategory("CALLS", {
        enabledPlatforms: ["ANDROID", "IOS"],
      });

      expect(store.find((r) => r.id === "CALLS")!.enabledPlatforms).toEqual([
        "ANDROID",
        "IOS",
      ]);
      expect((await service.getCatalogue("WEB")).version).not.toBe(before);
    });

    it("changes when priorities are reordered", async () => {
      const { repo } = fakeRepo(seededRows());
      const service = new NotificationCatalogueService(repo);
      const before = (await service.getCatalogue("WEB")).version;

      await service.updateCategory("CALLS", { priority: 1 });

      const after = await service.getCatalogue("WEB");
      expect(after.version).not.toBe(before);
      expect(after.categories[0].id).toBe("CALLS");
    });

    it("does not change for a platform the edit did not touch", async () => {
      const { repo } = fakeRepo(seededRows());
      const service = new NotificationCatalogueService(repo);
      const androidBefore = (await service.getCatalogue("ANDROID")).version;

      await service.updateCategory("CALLS", {
        enabledPlatforms: ["ANDROID", "IOS"],
      });

      expect((await service.getCatalogue("ANDROID")).version).toBe(
        androidBefore
      );
    });

    it("reports the most recent configuration change", async () => {
      const { repo } = fakeRepo(seededRows());
      const service = new NotificationCatalogueService(repo);

      expect((await service.getCatalogue("WEB")).updatedAt).toBe(
        AT.toISOString()
      );
    });
  });

  describe("admin surface", () => {
    it("lists every row with its full platform state", async () => {
      const { repo } = fakeRepo(seededRows());
      const service = new NotificationCatalogueService(repo);

      const rows = await service.listForAdmin();

      expect(rows).toHaveLength(6);
      expect(rows[0]).toMatchObject({
        id: "FRIEND_REQUEST",
        enabledPlatforms: ["ANDROID", "IOS", "WEB"],
      });
    });

    it("refuses an id outside the seeded catalogue instead of creating it", async () => {
      const { store, repo } = fakeRepo(seededRows());
      const service = new NotificationCatalogueService(repo);

      const result = await service.updateCategory("PROMOTIONS", {
        priority: 1,
      });

      expect(result).toBeNull();
      expect(store).toHaveLength(6);
    });

    it("accepts an empty platform list — the chip hides everywhere", async () => {
      const { repo } = fakeRepo(seededRows());
      const service = new NotificationCatalogueService(repo);

      await service.updateCategory("CALLS", { enabledPlatforms: [] });

      for (const platform of ["ANDROID", "IOS", "WEB"] as const) {
        expect(
          (await service.getCatalogue(platform)).categories.map((c) => c.id)
        ).not.toContain("CALLS");
      }
    });
  });

  describe("degraded reads", () => {
    it("serves the compiled-in seed when the collection is empty", async () => {
      const { repo } = fakeRepo([]);
      const service = new NotificationCatalogueService(repo);

      const { categories, updatedAt } = await service.getCatalogue("WEB");

      expect(categories.map((c) => c.id)).toEqual(
        NOTIFICATION_CATEGORY_SEED.map((c) => c.id)
      );
      expect(updatedAt).toBeNull();
    });

    it("serves the compiled-in seed when the read throws", async () => {
      const repo = {
        listAll: jest.fn(() => Promise.reject(new Error("mongo down"))),
      } as unknown as NotificationCategoryRepository;
      const service = new NotificationCatalogueService(repo);

      const { categories } = await service.getCatalogue("ANDROID");

      expect(categories).toHaveLength(6);
    });
  });
});
