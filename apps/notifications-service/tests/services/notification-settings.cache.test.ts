/**
 * Notification-settings cache coherence.
 *
 * Settings are cached in Redis for NOTIF_SETTINGS_CACHE_TTL_SEC (300 by
 * default) and the ONLY thing that makes a change visible sooner is the
 * `user.settings_updated` invalidation. So the cost of losing an invalidation
 * is five minutes of the user's old mute / quiet-hours / category state being
 * applied to every push — the exact complaint the cache is supposed to be
 * invisible to.
 *
 * The gap this closes: `invalidateNotificationSettings` swallowed its own Redis
 * errors and the consumer dead-lettered anything that threw, so a failed DEL
 * was acked as success and nothing anywhere still knew a change was owed.
 *
 * Also pinned here: a cache READ failure falls through to gRPC, which is what
 * makes a Redis outage safe rather than stale — during one, nothing is served
 * from cache at all.
 */
const store = new Map<string, string>();
const cacheGetJson = jest.fn(async (_redis: unknown, key: string) => {
  const raw = store.get(key);
  return raw === undefined ? null : (JSON.parse(raw) as unknown);
});
const cacheSetJson = jest.fn(
  async (_redis: unknown, key: string, value: unknown) => {
    store.set(key, JSON.stringify(value));
  }
);
const cacheDel = jest.fn(async (_redis: unknown, ...keys: string[]) => {
  for (const key of keys) store.delete(key);
});

jest.mock("@aimess/redis", () => ({
  __esModule: true,
  cacheGetJson: (...args: [unknown, string]) => cacheGetJson(...args),
  cacheSetJson: (...args: [unknown, string, unknown]) => cacheSetJson(...args),
  cacheDel: (...args: [unknown, ...string[]]) => cacheDel(...args),
  connectRedis: () => ({}),
}));

const getNotificationSettingsRpc = jest.fn();
jest.mock("../../src/grpc/user-settings.client.js", () => ({
  createUserSettingsClient: () => ({
    getNotificationSettings: getNotificationSettingsRpc,
  }),
}));

import {
  getNotificationSettings,
  getUserLocale,
  invalidateNotificationSettings,
} from "../../src/services/notification-settings.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const KEY = `notif:settings:${USER_ID}`;

const SETTINGS = {
  chatEnabled: true,
  callEnabled: true,
  friendRequestEnabled: true,
  systemEnabled: true,
  communityEnabled: true,
  liveStreamEnabled: true,
  showPreview: true,
  quietHoursEnabled: false,
  quietHoursStart: "",
  quietHoursEnd: "",
  quietHoursDays: [],
  timezone: "",
  language: "",
};

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  getNotificationSettingsRpc.mockResolvedValue(SETTINGS);
});

describe("getNotificationSettings", () => {
  it("fetches once and serves the second read from cache", async () => {
    await getNotificationSettings(USER_ID);
    await getNotificationSettings(USER_ID);

    expect(getNotificationSettingsRpc).toHaveBeenCalledTimes(1);
    expect(store.has(KEY)).toBe(true);
  });

  it("caches with the configured TTL", async () => {
    await getNotificationSettings(USER_ID);

    expect(cacheSetJson).toHaveBeenCalledWith(
      expect.anything(),
      KEY,
      SETTINGS,
      300
    );
  });

  it("re-reads from the source once the entry is invalidated", async () => {
    await getNotificationSettings(USER_ID);
    getNotificationSettingsRpc.mockResolvedValue({
      ...SETTINGS,
      chatEnabled: false,
    });

    // Still the old answer — this is the staleness the invalidation removes.
    expect((await getNotificationSettings(USER_ID)).chatEnabled).toBe(true);

    await invalidateNotificationSettings(USER_ID);

    expect((await getNotificationSettings(USER_ID)).chatEnabled).toBe(false);
  });

  it("expires on its own when nothing invalidates it", async () => {
    // The TTL backstop, simulated by dropping the key the way Redis would.
    await getNotificationSettings(USER_ID);
    store.delete(KEY);
    getNotificationSettingsRpc.mockResolvedValue({
      ...SETTINGS,
      quietHoursEnabled: true,
    });

    expect((await getNotificationSettings(USER_ID)).quietHoursEnabled).toBe(
      true
    );
  });

  it("goes to the source when the cache READ fails", async () => {
    // Why a Redis outage cannot produce stale settings: with reads failing,
    // every call reaches gRPC, which is fresh by definition.
    cacheGetJson.mockRejectedValueOnce(new Error("redis down"));

    const result = await getNotificationSettings(USER_ID);

    expect(result.chatEnabled).toBe(true);
    expect(getNotificationSettingsRpc).toHaveBeenCalledTimes(1);
  });

  it("does not cache the permissive fallback when the source is unavailable", async () => {
    // Caching allow-on-open would turn one gRPC blip into five minutes of
    // ignored preferences for that user.
    getNotificationSettingsRpc.mockRejectedValue(new Error("circuit open"));

    const result = await getNotificationSettings(USER_ID);

    expect(result.chatEnabled).toBe(true);
    expect(store.has(KEY)).toBe(false);
  });

  it("serves the recipient locale from the same entry", async () => {
    getNotificationSettingsRpc.mockResolvedValue({
      ...SETTINGS,
      language: "vi",
    });

    expect(await getUserLocale(USER_ID)).toBe("vi");
  });
});

describe("invalidateNotificationSettings", () => {
  it("deletes exactly that user's entry", async () => {
    await getNotificationSettings(USER_ID);
    await invalidateNotificationSettings(USER_ID);

    expect(cacheDel).toHaveBeenCalledWith(expect.anything(), KEY);
    expect(store.has(KEY)).toBe(false);
  });

  it("PROPAGATES a Redis failure instead of swallowing it", async () => {
    // The finding. A swallowed error meant the consumer acked the message and
    // the stale entry lived out its TTL with nothing left that knew.
    cacheDel.mockRejectedValueOnce(new Error("redis down"));

    await expect(invalidateNotificationSettings(USER_ID)).rejects.toThrow(
      "redis down"
    );
  });
});
