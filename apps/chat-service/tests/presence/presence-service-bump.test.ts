/**
 * PresenceService — batch presence reads + the presence-change conv:updated
 * fan-out (Requirement: whenever a user's presence flips, every peer they
 * share a PRIVATE room with gets a fresh conv:updated with the new isOffline,
 * without waiting for a new message).
 */
import { PresenceService } from "../../src/services/presence.service.js";

function makeCacheRepo(opts: {
  sessions?: Array<Record<string, unknown>>;
  presenceByUser?: Record<string, string | null>;
}) {
  return {
    getDeviceSessions: jest.fn(async () => opts.sessions ?? []),
    getUserPresence: jest.fn(
      async (userId: string) => opts.presenceByUser?.[userId] ?? null
    ),
    setUserPresence: jest.fn(async () => undefined),
    setLastSeen: jest.fn(async () => undefined),
    getUserPresences: jest.fn(
      async (userIds: string[]) =>
        new Map(userIds.map((id) => [id, opts.presenceByUser?.[id] ?? null]))
    ),
  } as any;
}

function makeFakeRedis() {
  const publishCalls: Array<{ channel: string; payload: string }> = [];
  const pipeline = {
    publish(channel: string, payload: string) {
      publishCalls.push({ channel, payload });
      return pipeline;
    },
    async exec() {
      return [];
    },
  };
  return {
    redis: {
      publish: jest.fn(async (channel: string, payload: string) => {
        publishCalls.push({ channel, payload });
        return 1;
      }),
      pipeline: () => pipeline,
    } as any,
    publishCalls,
  };
}

describe("PresenceService.getPresenceMany", () => {
  it("batches presence for multiple users via cacheRepo.getUserPresences", async () => {
    const cacheRepo = makeCacheRepo({
      presenceByUser: { a: "online", b: "offline", c: null },
    });
    const svc = new PresenceService(cacheRepo, null);

    const result = await svc.getPresenceMany(["a", "b", "c"]);

    expect(result.get("a")).toBe(true);
    expect(result.get("b")).toBe(false);
    expect(result.get("c")).toBe(false);
  });

  it("returns an empty map for empty input, and tolerates a non-Map cacheRepo response", async () => {
    const svc1 = new PresenceService(makeCacheRepo({}), null);
    expect((await svc1.getPresenceMany([])).size).toBe(0);

    const badCacheRepo = {
      getUserPresences: jest.fn(async () => undefined),
    } as any;
    const svc2 = new PresenceService(badCacheRepo, null);
    const result = await svc2.getPresenceMany(["x"]);
    expect(result.size).toBe(0);
  });
});

describe("PresenceService.recompute — presence-change conv:updated fan-out", () => {
  it("bumps conv:updated (with isOffline) to every peer sharing a private room, on a status flip", async () => {
    const cacheRepo = makeCacheRepo({
      sessions: [
        { realtimeConnected: "1", appState: "FOREGROUND", lastActiveAt: "0" },
      ],
      presenceByUser: { u1: "offline" }, // previous status offline -> now online
    });
    const { redis, publishCalls } = makeFakeRedis();
    const privateRoomRepo = {
      findRoomsForPresenceBump: jest.fn(async () => [
        {
          roomId: "room-1",
          peerId: "peer-1",
          lastMessageId: "msg-1",
          lastMessage: {
            content: { text: "hi" },
            senderId: "u1",
            messageType: "TEXT",
          },
          lastMessageAt: new Date(1000),
        },
      ]),
    } as any;

    const svc = new PresenceService(cacheRepo, redis, privateRoomRepo);
    await svc.recompute("u1");
    // The bump runs fire-and-forget inside recompute(); flush microtasks.
    await new Promise((r) => setImmediate(r));

    const statusMsg = publishCalls.find(
      (c) =>
        c.channel === "user:u1" &&
        JSON.parse(c.payload).event === "presence:status"
    );
    expect(statusMsg).toBeDefined();

    const bump = publishCalls.find((c) => c.channel === "user:peer-1");
    expect(bump).toBeDefined();
    const data = JSON.parse(bump!.payload);
    expect(data.event).toBe("conv:updated");
    expect(data.data.type).toBe("PRIVATE");
    expect(data.data.roomId).toBe("room-1");
    expect(data.data.isOffline).toBe(false); // u1 just came online
    expect(data.data.unread).toBe(false);
  });

  it("does nothing when no PrivateRoomRepository was injected", async () => {
    const cacheRepo = makeCacheRepo({
      sessions: [
        { realtimeConnected: "1", appState: "FOREGROUND", lastActiveAt: "0" },
      ],
      presenceByUser: { u1: "offline" },
    });
    const { redis, publishCalls } = makeFakeRedis();
    const svc = new PresenceService(cacheRepo, redis);

    await svc.recompute("u1");
    await new Promise((r) => setImmediate(r));

    expect(publishCalls.filter((c) => c.channel === "user:peer-1").length).toBe(
      0
    );
  });
});
