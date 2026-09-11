/**
 * The catalogue seed runs on every deployment, so the two properties that
 * matter are that it never duplicates a row and never quietly reverts an
 * administrator's configuration.
 *
 * Both come from the same decision: `_id` IS the stable catalogue id, so the
 * seed addresses a row by name rather than inserting and hoping.
 */
import {
  seedNotificationCategories,
  type NotificationCategorySeedClient,
} from "../../prisma/seed/notification-categories.seed.js";
import { NOTIFICATION_CATEGORY_SEED } from "../../src/lib/notification-category.js";

interface StoredRow {
  id: string;
  priority: number;
  defaultLabel: string;
  iconKey: string;
  enabledPlatforms: string[];
}

function fakeCollection(initial: StoredRow[] = []) {
  const rows = new Map(initial.map((r) => [r.id, { ...r }]));
  const client: NotificationCategorySeedClient = {
    notificationCategoryConfig: {
      findUnique: ({ where }) =>
        Promise.resolve(rows.has(where.id) ? { id: where.id } : null),
      update: ({ where, data }) => {
        Object.assign(rows.get(where.id)!, data);
        return Promise.resolve(rows.get(where.id));
      },
      create: ({ data }) => {
        if (rows.has(data.id)) throw new Error(`duplicate row ${data.id}`);
        rows.set(data.id, { ...data });
        return Promise.resolve(data);
      },
    },
  };
  return { rows, client };
}

describe("notification category seed", () => {
  it("creates the six fixed categories on a fresh database", async () => {
    const { rows, client } = fakeCollection();

    const result = await seedNotificationCategories(client);

    expect(result).toEqual({ created: 6, updated: 0 });
    expect([...rows.keys()]).toEqual(
      NOTIFICATION_CATEGORY_SEED.map((c) => c.id)
    );
  });

  it("creates no duplicates when the deployment runs it again", async () => {
    const { rows, client } = fakeCollection();

    await seedNotificationCategories(client);
    const second = await seedNotificationCategories(client);
    const third = await seedNotificationCategories(client);

    expect(second).toEqual({ created: 0, updated: 6 });
    expect(third).toEqual({ created: 0, updated: 6 });
    expect(rows.size).toBe(6);
  });

  it("seeds stable ids, priorities and platform enablement", async () => {
    const { rows, client } = fakeCollection();

    await seedNotificationCategories(client);

    expect(rows.get("CALLS")).toEqual({
      id: "CALLS",
      priority: 4,
      defaultLabel: "Calls",
      iconKey: "call",
      enabledPlatforms: ["ANDROID", "IOS", "WEB"],
    });
  });

  it("leaves an administrator's priority and platform choices alone", async () => {
    const { rows, client } = fakeCollection();
    await seedNotificationCategories(client);

    // Super Admin turns Calls off for Web and moves it to the front.
    const calls = rows.get("CALLS")!;
    calls.priority = 1;
    calls.enabledPlatforms = ["ANDROID", "IOS"];

    await seedNotificationCategories(client);

    expect(rows.get("CALLS")).toMatchObject({
      priority: 1,
      enabledPlatforms: ["ANDROID", "IOS"],
    });
  });

  it("repairs a label or icon key that drifted from the code", async () => {
    const { rows, client } = fakeCollection();
    await seedNotificationCategories(client);
    rows.get("SYSTEM")!.defaultLabel = "Old Name";
    rows.get("SYSTEM")!.iconKey = "retired_glyph";

    await seedNotificationCategories(client);

    expect(rows.get("SYSTEM")).toMatchObject({
      defaultLabel: "System",
      iconKey: "settings",
    });
  });
});
