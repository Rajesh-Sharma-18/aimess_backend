/**
 * Suite: LivestreamCommentService.addComment — YouTube-style live chat throttles
 *
 * Flood: > STREAM_COMMENT_FLOOD_MAX (5) sends in the window rejects THAT send
 * with LIVE_CHAT_FLOOD + retryAfterSec (cooldown), never a ban. Slow mode
 * rejects with LIVE_CHAT_SLOW_MODE. Host + community ADMIN/MODERATOR are exempt.
 * Reads (getComments) are untouched by either.
 */
import { TooManyRequestsError } from "@aimess/errors";
import { LivestreamCommentService } from "../../src/services/livestream-comment.service.js";

/** Minimal in-memory Redis: just the calls the limiter + broadcast make. */
function fakeRedis() {
  const store = new Map<string, { v: number; exp?: number }>();
  const live = (k: string) => {
    const e = store.get(k);
    if (e?.exp !== undefined && e.exp <= Date.now()) store.delete(k);
    return store.get(k);
  };
  return {
    publish: jest.fn().mockResolvedValue(1),
    ttl: async (k: string) => {
      const e = live(k);
      if (!e) return -2;
      return e.exp === undefined ? -1 : Math.ceil((e.exp - Date.now()) / 1000);
    },
    incr: async (k: string) => {
      const e = live(k) ?? { v: 0 };
      e.v += 1;
      store.set(k, e);
      return e.v;
    },
    expire: async (k: string, sec: number) => {
      const e = live(k);
      if (e) e.exp = Date.now() + sec * 1000;
      return e ? 1 : 0;
    },
    set: async (k: string, _v: string, _ex: string, sec: number, nx?: string) => {
      if (nx === "NX" && live(k)) return null;
      store.set(k, { v: 1, exp: Date.now() + sec * 1000 });
      return "OK";
    },
    del: async (k: string) => (store.delete(k) ? 1 : 0),
  };
}

function makeService(opts: { role?: string; slowModeSec?: number } = {}) {
  let n = 0;
  const commentRepo = {
    findByClientCommentId: jest.fn().mockResolvedValue(null),
    createComment: jest.fn().mockImplementation((d: Record<string, unknown>) =>
      Promise.resolve({
        id: `c-${++n}`,
        livestreamId: d.livestreamId,
        sentBy: d.sentBy,
        senderName: "",
        senderAvatar: "",
        message: d.message,
        clientCommentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    ),
    findByLivestreamId: jest.fn().mockResolvedValue([]),
  };
  const streamRepo = {
    findById: jest.fn().mockResolvedValue({
      id: "s1",
      communityId: "comm-1",
      creatorId: "host-1",
      commentStatus: true,
      slowModeSec: opts.slowModeSec ?? null,
    }),
    incrementTotalComments: jest.fn().mockResolvedValue(undefined),
  };
  const communityClient = {
    checkMute: jest.fn().mockResolvedValue({ isMuted: false }),
    checkBan: jest.fn().mockResolvedValue({ isBanned: false }),
    checkCommunityAccess: jest.fn().mockResolvedValue({
      isBanned: false,
      isMember: true,
      isPublicCommunity: true,
    }),
    validateMembership: jest.fn().mockResolvedValue({
      isMember: true,
      isCommunityClosed: false,
      role: opts.role ?? "MEMBER",
    }),
  };
  const service = new LivestreamCommentService(
    commentRepo as any,
    streamRepo as any,
    { bulkGetUserSnapshots: jest.fn().mockResolvedValue([]) } as any,
    fakeRedis() as any,
    { isBanned: jest.fn().mockResolvedValue(false) } as any,
    communityClient as any,
    {} as any
  );
  return { service, commentRepo };
}

const send = (service: LivestreamCommentService, userId: string, i: number) =>
  service.addComment({ livestreamId: "s1", userId, message: `m${i}` });

describe("live chat throttles", () => {
  it("burst: 6th send in the window is LIVE_CHAT_FLOOD with a cooldown; nothing persisted", async () => {
    const { service, commentRepo } = makeService();
    for (let i = 0; i < 5; i++) await send(service, "viewer-1", i);

    const err = await send(service, "viewer-1", 5).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TooManyRequestsError);
    expect((err as TooManyRequestsError).messageKey).toBe("LIVE_CHAT_FLOOD");
    expect((err as TooManyRequestsError).retryAfterSec).toBe(5);
    expect(commentRepo.createComment).toHaveBeenCalledTimes(5);

    // Still blocked during the cooldown — and not a ban: no 403.
    await expect(send(service, "viewer-1", 6)).rejects.toMatchObject({
      messageKey: "LIVE_CHAT_FLOOD",
    });
    // Another user is a separate bucket.
    await expect(send(service, "viewer-2", 0)).resolves.toBeDefined();
  });

  it("flood cooldown lifts after exactly 5s, and re-triggers the same way", async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    try {
      const { service } = makeService();
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < 5; i++) await send(service, "viewer-1", i);
        await expect(send(service, "viewer-1", 5)).rejects.toMatchObject({
          messageKey: "LIVE_CHAT_FLOOD",
          retryAfterSec: 5,
        });
        // The client counts 5 → 1; any send before then is still rejected.
        jest.advanceTimersByTime(4_000);
        await expect(send(service, "viewer-1", 6)).rejects.toMatchObject({
          messageKey: "LIVE_CHAT_FLOOD",
          retryAfterSec: 1,
        });
        jest.advanceTimersByTime(1_000);
        await expect(send(service, "viewer-1", 7)).resolves.toBeDefined();
        jest.advanceTimersByTime(10_000); // let the flood window drain before the next round
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it("host and community moderators are exempt from flood", async () => {
    const { service } = makeService();
    for (let i = 0; i < 12; i++) await send(service, "host-1", i);

    const mod = makeService({ role: "MODERATOR" });
    for (let i = 0; i < 12; i++) await send(mod.service, "mod-1", i);
  });

  it("slow mode: second send inside the window is LIVE_CHAT_SLOW_MODE; mods skip it", async () => {
    const { service } = makeService({ slowModeSec: 10 });
    await send(service, "viewer-1", 0);
    await expect(send(service, "viewer-1", 1)).rejects.toMatchObject({
      messageKey: "LIVE_CHAT_SLOW_MODE",
      retryAfterSec: 10,
    });

    const admin = makeService({ role: "ADMIN", slowModeSec: 10 });
    await send(admin.service, "admin-1", 0);
    await send(admin.service, "admin-1", 1);
  });

  it("reads still succeed while the sender is flood-blocked", async () => {
    const { service } = makeService();
    for (let i = 0; i < 6; i++) await send(service, "viewer-1", i).catch(() => {});
    await expect(
      service.getComments("s1", { limit: 20 }, "viewer-1")
    ).resolves.toEqual({ items: [], nextCursor: null, hasMore: false });
  });
});
