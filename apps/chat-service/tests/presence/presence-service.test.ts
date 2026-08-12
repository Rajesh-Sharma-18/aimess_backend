/**
 * PresenceService — the online/offline state machine.
 *
 * Covers the behaviours the WhatsApp-style contract rests on:
 *  - presence is derived from ACTIVE SESSIONS, so multi-device works
 *  - `presence:status` is published on a real transition and only then
 *  - lastSeen is server-generated and stamped when the LAST session goes
 *  - a stale (never-cleanly-disconnected) session still resolves to OFFLINE
 *  - every event carries a monotonic version for out-of-order protection
 */
import { PresenceService } from "../../src/services/presence.service.js";

type Session = Record<string, string>;

/**
 * Cache-repo double with a real (in-memory) transition rule, so `changed` is
 * decided the same way the Lua script decides it: a flip against the STORED
 * status, with a missing key reading as offline.
 */
function makeCacheRepo(initial?: {
  sessionsByUser?: Record<string, Session[]>;
  statusByUser?: Record<string, string>;
  lastSeenByUser?: Record<string, number>;
}) {
  const sessions = { ...(initial?.sessionsByUser ?? {}) };
  const status: Record<string, string> = { ...(initial?.statusByUser ?? {}) };
  const lastSeen: Record<string, number> = {
    ...(initial?.lastSeenByUser ?? {}),
  };
  const version: Record<string, number> = {};
  const onlineIndex = new Map<string, number>();

  const repo = {
    sessions,
    status,
    onlineIndex,
    getDeviceSessions: jest.fn(
      async (userId: string) => sessions[userId] ?? []
    ),
    applyPresenceTransition: jest.fn(
      async (userId: string, isOnline: boolean, nowMs: number) => {
        const next = isOnline ? "online" : "offline";
        const prev = status[userId] ?? "offline";
        status[userId] = next;
        const changed = prev !== next;
        if (changed) version[userId] = (version[userId] ?? 0) + 1;
        if (!isOnline) lastSeen[userId] = nowMs;
        return {
          changed,
          version: version[userId] ?? 0,
          lastSeen: lastSeen[userId] ?? null,
        };
      }
    ),
    setOnlineIndex: jest.fn(
      async (userId: string, isOnline: boolean, staleAtMs: number) => {
        if (isOnline) onlineIndex.set(userId, staleAtMs);
        else onlineIndex.delete(userId);
      }
    ),
    getStaleOnlineUserIds: jest.fn(async (nowMs: number, limit: number) =>
      [...onlineIndex.entries()]
        .filter(([, staleAt]) => staleAt <= nowMs)
        .slice(0, limit)
        .map(([userId]) => userId)
    ),
    getPresenceSnapshots: jest.fn(async (userIds: string[]) => {
      const map = new Map();
      for (const id of userIds) {
        map.set(id, {
          userId: id,
          isOnline: status[id] === "online",
          lastSeen: lastSeen[id] ?? null,
          version: version[id] ?? 0,
        });
      }
      return map;
    }),
    upsertDeviceSession: jest.fn(async () => undefined),
    setDisconnected: jest.fn(async () => undefined),
    heartbeat: jest.fn(async () => undefined),
    setAppState: jest.fn(async () => undefined),
    getUserPresence: jest.fn(async (userId: string) => status[userId] ?? null),
    getUserPresences: jest.fn(
      async (userIds: string[]) =>
        new Map(userIds.map((id) => [id, status[id] ?? null]))
    ),
    getLastSeen: jest.fn(async (userId: string) => lastSeen[userId] ?? null),
    setUserPresence: jest.fn(async () => undefined),
    setLastSeen: jest.fn(async () => undefined),
  };
  return repo as typeof repo & Record<string, unknown>;
}

function makeFakeRedis() {
  const published: Array<{ channel: string; event: string; data: any }> = [];
  return {
    published,
    redis: {
      publish: jest.fn(async (channel: string, raw: string) => {
        const parsed = JSON.parse(raw);
        published.push({ channel, event: parsed.event, data: parsed.data });
        return 1;
      }),
    } as any,
  };
}

const live = (appState = "FOREGROUND"): Session => ({
  realtimeConnected: "1",
  appState,
  lastActiveAt: String(Date.now()),
});

const allowAllGate = {
  filterVisiblePresence: async (_viewerId: string, peerIds: string[]) =>
    new Set(peerIds),
  filterPresenceViewers: async (_subjectId: string, viewerIds: string[]) =>
    new Set(viewerIds),
};

const statusEvents = (published: Array<{ event: string; data: any }>) =>
  published.filter((p) => p.event === "presence:status");

describe("PresenceService — transitions", () => {
  it("publishes ONLINE on the first live session, on the subject's own channel", async () => {
    const cacheRepo = makeCacheRepo({ sessionsByUser: { u1: [live()] } });
    const { redis, published } = makeFakeRedis();
    const svc = new PresenceService(cacheRepo as any, redis, {}, allowAllGate);

    await svc.recompute("u1");

    expect(statusEvents(published)).toHaveLength(1);
    expect(published[0].channel).toBe("user:u1");
    expect(published[0].data).toMatchObject({ userId: "u1", isOnline: true });
    expect(published[0].data.version).toBeGreaterThan(0);
  });

  it("publishes nothing when the status did not actually change", async () => {
    const cacheRepo = makeCacheRepo({ sessionsByUser: { u1: [live()] } });
    const { redis, published } = makeFakeRedis();
    const svc = new PresenceService(cacheRepo as any, redis, {}, allowAllGate);

    await svc.recompute("u1");
    await svc.recompute("u1");
    await svc.recompute("u1");

    expect(statusEvents(published)).toHaveLength(1);
  });

  it("NEVER re-publishes presence as a conv:updated list bump", async () => {
    const cacheRepo = makeCacheRepo({ sessionsByUser: { u1: [live()] } });
    const { redis, published } = makeFakeRedis();
    const svc = new PresenceService(cacheRepo as any, redis, {}, allowAllGate);

    await svc.recompute("u1");
    await new Promise((r) => setImmediate(r));

    // A presence flip must not rewrite conversation rows: the old fan-out
    // republished `lastMessageAt: 0` for rooms with no messages yet.
    expect(published.some((p) => p.event === "conv:updated")).toBe(false);
  });
});

describe("PresenceService — multi-device", () => {
  it("stays ONLINE while any session remains, and goes OFFLINE only when the last one goes", async () => {
    const cacheRepo = makeCacheRepo({
      sessionsByUser: { u1: [live(), live()] }, // web + mobile
    });
    const { redis, published } = makeFakeRedis();
    const svc = new PresenceService(cacheRepo as any, redis, {}, allowAllGate);

    await svc.recompute("u1"); // → ONLINE
    expect(statusEvents(published)).toHaveLength(1);

    // Web disconnects; mobile still holds a live session.
    cacheRepo.sessions.u1 = [live()];
    await svc.disconnect("u1", "web-socket");
    expect(statusEvents(published)).toHaveLength(1); // still online, no event
    expect(cacheRepo.status.u1).toBe("online");

    // Mobile disconnects too.
    cacheRepo.sessions.u1 = [];
    await svc.disconnect("u1", "mobile-socket");
    const events = statusEvents(published);
    expect(events).toHaveLength(2);
    expect(events[1].data.isOnline).toBe(false);
    expect(events[1].data.lastSeen).toEqual(expect.any(Number));
    expect(events[1].data.version).toBeGreaterThan(events[0].data.version);
  });

  it("does not stamp lastSeen while another session is still live", async () => {
    const cacheRepo = makeCacheRepo({
      sessionsByUser: { u1: [live(), live()] },
    });
    const { redis } = makeFakeRedis();
    const svc = new PresenceService(cacheRepo as any, redis, {}, allowAllGate);

    await svc.recompute("u1");
    cacheRepo.sessions.u1 = [live()];
    await svc.disconnect("u1", "one-of-two");

    expect(await cacheRepo.getLastSeen("u1")).toBeNull();
  });
});

describe("PresenceService — stale sessions", () => {
  it("re-derives OFFLINE for a user whose sessions expired without a disconnect", async () => {
    const cacheRepo = makeCacheRepo({ sessionsByUser: { u1: [live()] } });
    const { redis, published } = makeFakeRedis();
    const svc = new PresenceService(
      cacheRepo as any,
      redis,
      { staleAfterMs: -1 }, // already past due, so the first sweep picks it up
      allowAllGate
    );

    await svc.recompute("u1");
    expect(cacheRepo.status.u1).toBe("online");

    // The process died: the device-session hashes are gone, but nothing has
    // published anything — this is precisely the "stuck Online" case.
    cacheRepo.sessions.u1 = [];

    const swept = await svc.sweepStaleSessions(100);

    expect(swept).toBe(1);
    const events = statusEvents(published);
    expect(events[events.length - 1].data).toMatchObject({
      userId: "u1",
      isOnline: false,
    });
    expect(cacheRepo.onlineIndex.has("u1")).toBe(false);
  });

  it("leaves a still-live user online and re-arms their deadline", async () => {
    const cacheRepo = makeCacheRepo({ sessionsByUser: { u1: [live()] } });
    const { redis, published } = makeFakeRedis();
    const svc = new PresenceService(
      cacheRepo as any,
      redis,
      { staleAfterMs: -1 },
      allowAllGate
    );

    await svc.recompute("u1");
    await svc.sweepStaleSessions(100);

    expect(cacheRepo.status.u1).toBe("online");
    expect(statusEvents(published)).toHaveLength(1); // no spurious flap
  });
});

describe("PresenceService — viewer-scoped reads", () => {
  it("returns status + lastSeen + version for peers the viewer may see", async () => {
    const cacheRepo = makeCacheRepo({
      sessionsByUser: { peer: [live()] },
    });
    const { redis } = makeFakeRedis();
    const svc = new PresenceService(cacheRepo as any, redis, {}, allowAllGate);

    await svc.recompute("peer");
    const views = await svc.getPresenceViewsFor("viewer", ["peer"]);

    expect(views.get("peer")).toMatchObject({
      userId: "peer",
      isOnline: true,
      version: 1,
    });
  });

  it("PRIVACY: a peer whoCanSeeOnlineStatus excludes reads as offline with no lastSeen", async () => {
    const cacheRepo = makeCacheRepo({ sessionsByUser: { peer: [live()] } });
    const { redis } = makeFakeRedis();
    const denyAll = {
      filterVisiblePresence: async () => new Set<string>(),
      filterPresenceViewers: async () => new Set<string>(),
    };
    const svc = new PresenceService(cacheRepo as any, redis, {}, denyAll);

    await svc.recompute("peer");
    const views = await svc.getPresenceViewsFor("viewer", ["peer"]);

    expect(views.get("peer")).toEqual({
      userId: "peer",
      isOnline: false,
      lastSeen: null,
      version: 0,
    });
  });

  it("PRIVACY: with no visibility gate wired at all, everything reads offline", async () => {
    const cacheRepo = makeCacheRepo({ sessionsByUser: { peer: [live()] } });
    const { redis } = makeFakeRedis();
    const svc = new PresenceService(cacheRepo as any, redis);

    await svc.recompute("peer");
    const views = await svc.getPresenceViewsFor("viewer", ["peer"]);

    expect(views.get("peer")?.isOnline).toBe(false);
  });
});

describe("PresenceService.getPresenceMany", () => {
  it("batches presence for multiple users via cacheRepo.getUserPresences", async () => {
    const cacheRepo = makeCacheRepo({
      statusByUser: { a: "online", b: "offline" },
    });
    const svc = new PresenceService(cacheRepo as any, null);

    const result = await svc.getPresenceMany(["a", "b", "c"]);

    expect(result.get("a")).toBe(true);
    expect(result.get("b")).toBe(false);
    expect(result.get("c")).toBe(false);
  });

  it("returns an empty map for empty input, and tolerates a non-Map cacheRepo response", async () => {
    const svc1 = new PresenceService(makeCacheRepo() as any, null);
    expect((await svc1.getPresenceMany([])).size).toBe(0);

    const badCacheRepo = {
      getUserPresences: jest.fn(async () => undefined),
    } as any;
    const svc2 = new PresenceService(badCacheRepo, null);
    expect((await svc2.getPresenceMany(["x"])).size).toBe(0);
  });
});
