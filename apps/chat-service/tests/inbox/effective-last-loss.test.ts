/**
 * Delete-for-everyone on a message that was NOT the room's shared last one.
 *
 * The shared recalculation correctly returns null there (the snapshot did not
 * move), and every delete path used to publish nothing at all — so a member who
 * had personally hidden every message NEWER than the removed one kept previewing
 * a message that no longer exists for anybody. The exact reported repro:
 *
 *   A sends "Hey"(m1) then "Hello"(m2)  -> shared last = m2
 *   A deletes "Hello" for me            -> A's row previews "Hey"
 *   admin deletes "Hey" for everyone    -> shared last still m2, recalc null,
 *                                          A's row stayed on "Hey"
 *
 * These pin the resolver's selection rules and the wire/persistence contract of
 * the fan-out that fixes it.
 */
jest.mock("../../src/events/unread-summary-bridge.js", () => ({
  notifyUnreadChanged: jest.fn(),
}));
const updateMessageActivity = jest.fn(async () => true);
jest.mock("../../src/grpc/community.client.js", () => ({
  getCommunityReconcileClient: () => ({ updateMessageActivity }),
}));

import {
  resolveEffectiveLastLosers,
  type VisibilitySource,
  type VisibleLast,
} from "../../src/services/last-visible-resolver.js";
import {
  publishCommunityEffectiveLastLoss,
  publishConvEffectiveLastLoss,
} from "../../src/events/publish-effective-last-loss.js";

const ROOM = "room_1";
const COMMUNITY = "cmy_1";
const A = "user-a";
const ADMIN = "user-admin";
const B = "user-b";

const HEY_AT = new Date(1_700_000_001_000); // m1, the message deleted for everyone
const HELLO_AT = new Date(1_700_000_002_000); // m2, the shared last
const MORNING_AT = new Date(1_700_000_003_000); // m3

function msg(id: string, createdAt: Date, content = "text"): VisibleLast {
  return {
    messageId: id,
    senderId: "s1",
    senderName: "Alice",
    messageType: "TEXT",
    content,
    createdAt,
    clientMessageId: `cmid-${id}`,
    sequenceNumber: 7,
    revision: 2,
  };
}

/** Declarative source: who hid the shared last, and each user's own prev. */
function source(opts: {
  hiders?: Record<string, string[]>;
  prevByUser?: Record<string, VisibleLast | null>;
}) {
  const calls = { hidersAmong: 0, prev: [] as string[] };
  const src: VisibilitySource = {
    filterHidden: jest.fn(async () => new Set<string>()),
    hidersAmong: jest.fn(async (messageId: string, userIds: string[]) => {
      calls.hidersAmong++;
      const hid = new Set(opts.hiders?.[messageId] ?? []);
      return new Set(userIds.filter((u) => hid.has(u)));
    }),
    findPreviousVisibleForUser: jest.fn(
      async (_roomId: string, userId: string) => {
        calls.prev.push(userId);
        return opts.prevByUser?.[userId] ?? null;
      }
    ),
  };
  return { src, calls };
}

beforeEach(() => jest.clearAllMocks());

describe("resolveEffectiveLastLosers", () => {
  it("REPRO: the member who hid the shared last and has nothing else left", async () => {
    const { src } = source({
      hiders: { m2: [A] },
      prevByUser: { [A]: null },
    });
    const out = await resolveEffectiveLastLosers(src, ROOM, "m2", HEY_AT, [
      A,
      ADMIN,
      B,
    ]);
    expect([...out.keys()]).toEqual([A]);
    expect(out.get(A)).toBeNull(); // nothing visible remains -> empty state
  });

  it("costs ONE lookup and returns nothing when nobody hid the shared last", async () => {
    const { src, calls } = source({ hiders: {} });
    const out = await resolveEffectiveLastLosers(src, ROOM, "m2", HEY_AT, [
      A,
      ADMIN,
      B,
    ]);
    expect(out.size).toBe(0);
    expect(calls.hidersAmong).toBe(1);
    expect(calls.prev).toEqual([]); // no per-member fallback queries at all
  });

  it("EXCLUDES a hider whose own newest visible message is NEWER than the removed one", async () => {
    // A hid m3 (the shared last) but still sees m2 — removing m1 changes nothing
    // for them, so no bump is warranted.
    const { src } = source({
      hiders: { m3: [A] },
      prevByUser: { [A]: msg("m2", HELLO_AT) },
    });
    const out = await resolveEffectiveLastLosers(src, ROOM, "m3", HEY_AT, [
      A,
      B,
    ]);
    expect(out.size).toBe(0);
  });

  it("carries the surviving message's preview + list identity for a loser", async () => {
    const { src } = source({
      hiders: { m2: [A] },
      // A hid m2; m1 is being deleted for everyone; an OLDER m0 survives.
      prevByUser: {
        [A]: msg("m0", new Date(HEY_AT.getTime() - 1000), "older"),
      },
    });
    const out = await resolveEffectiveLastLosers(src, ROOM, "m2", HEY_AT, [A]);
    expect(out.get(A)).toMatchObject({
      lastMessageId: "m0",
      lastMessageAt: HEY_AT.getTime() - 1000,
      content: "older",
      clientMessageId: "cmid-m0",
      sequenceNumber: 7,
      revision: 2,
    });
  });

  it("treats a same-millisecond tie as 'it was their last'", async () => {
    const { src } = source({
      hiders: { m2: [A] },
      prevByUser: { [A]: msg("m1b", HEY_AT) },
    });
    const out = await resolveEffectiveLastLosers(src, ROOM, "m2", HEY_AT, [A]);
    expect(out.get(A)).toMatchObject({ lastMessageId: "m1b" });
  });

  it("does nothing for an already-empty room or an empty member list", async () => {
    const { src, calls } = source({ hiders: { m2: [A] } });
    expect(
      (await resolveEffectiveLastLosers(src, ROOM, null, HEY_AT, [A])).size
    ).toBe(0);
    expect(
      (await resolveEffectiveLastLosers(src, ROOM, "m2", HEY_AT, [])).size
    ).toBe(0);
    expect(calls.hidersAmong).toBe(0);
  });
});

type Published = { channel: string; data: Record<string, unknown> };

function fakeRedis() {
  const published: Published[] = [];
  const pipeline = {
    publish: (channel: string, raw: string) => {
      published.push({
        channel,
        data: (JSON.parse(raw) as { data: Record<string, unknown> }).data,
      });
      return pipeline;
    },
    exec: async () => [],
  };
  return {
    redis: { pipeline: () => pipeline } as never,
    published,
    forUser: (id: string) =>
      published.find((p) => p.channel === `user:${id}`)?.data,
  };
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe("publishConvEffectiveLastLoss (private/group wire contract)", () => {
  it("bumps ONLY the affected member, marked so the monotonic guard lets it through", async () => {
    const { redis, published, forUser } = fakeRedis();
    await publishConvEffectiveLastLoss({
      redis,
      type: "GROUP",
      roomId: ROOM,
      recipientIds: () => Promise.resolve([A, ADMIN, B]),
      deletedMessageCreatedAt: HEY_AT,
      resolveLosers: () => Promise.resolve(new Map([[A, null]])),
      projectionRevision: 42,
    });
    await flush();

    expect(published.map((p) => p.channel)).toEqual([`user:${A}`]);
    expect(forUser(A)).toMatchObject({
      deleteRecalc: true,
      projectionRevision: 42,
      // nothing visible left -> sorts to the BOTTOM, never jumps to the top
      lastMessageAt: 0,
    });
  });

  it("publishes nothing when no member lost their effective last", async () => {
    const { redis, published } = fakeRedis();
    await publishConvEffectiveLastLoss({
      redis,
      type: "PRIVATE",
      roomId: ROOM,
      recipientIds: () => Promise.resolve([A, B]),
      deletedMessageCreatedAt: HEY_AT,
      resolveLosers: () => Promise.resolve(new Map()),
    });
    await flush();
    expect(published).toEqual([]);
  });
});

describe("publishCommunityEffectiveLastLoss (wire + PERSISTED overlay)", () => {
  it("rewrites the stale delete-for-me self overlay and bumps only that member", async () => {
    const { redis, published, forUser } = fakeRedis();
    await publishCommunityEffectiveLastLoss({
      redis,
      communityId: COMMUNITY,
      roomId: ROOM,
      memberIds: () => Promise.resolve([A, ADMIN, B]),
      deletedMessageId: "m1",
      deletedMessageCreatedAt: HEY_AT,
      resolveLosers: () => Promise.resolve(new Map([[A, null]])),
    });
    await flush();

    // Without this the row keeps the removed message's text across reloads —
    // lastActivitySelfPreview carries no message identity of its own.
    expect(updateMessageActivity).toHaveBeenCalledWith({
      communityId: COMMUNITY,
      selfUserId: A,
      selfPreview: "",
    });
    expect(published.map((p) => p.channel)).toEqual([`user:${A}`]);
    expect(forUser(A)).toMatchObject({
      deleteRecalc: true,
      lastMessageAt: 0,
    });
    // Preview-only correction: no unread delta rides along (the removed message
    // was not the shared last, so the badge story is unchanged) — and
    // `deleteRecalcId` is only ever wired to a delta, so it stays off the wire.
    expect(forUser(A)).not.toHaveProperty("unreadDelta");
  });

  it("persists the surviving message's preview when one remains", async () => {
    const { redis, forUser } = fakeRedis();
    await publishCommunityEffectiveLastLoss({
      redis,
      communityId: COMMUNITY,
      roomId: ROOM,
      memberIds: () => Promise.resolve([A, B]),
      deletedMessageId: "m1",
      deletedMessageCreatedAt: HEY_AT,
      resolveLosers: () =>
        Promise.resolve(
          new Map([
            [
              A,
              {
                lastMessageId: "m3",
                lastMessageAt: MORNING_AT.getTime(),
                senderId: B,
                senderName: "Bob",
                messageType: "TEXT",
                content: "Good morning",
              },
            ],
          ])
        ),
    });
    await flush();

    expect(updateMessageActivity).toHaveBeenCalledWith({
      communityId: COMMUNITY,
      selfUserId: A,
      selfPreview: "Good morning",
    });
    expect(forUser(A)).toMatchObject({
      lastMessageId: "m3",
      lastMessageAt: MORNING_AT.getTime(),
    });
  });

  it("touches nothing when no member lost their effective last", async () => {
    const { redis, published } = fakeRedis();
    await publishCommunityEffectiveLastLoss({
      redis,
      communityId: COMMUNITY,
      roomId: ROOM,
      memberIds: () => Promise.resolve([A, B]),
      deletedMessageId: "m1",
      deletedMessageCreatedAt: HEY_AT,
      resolveLosers: () => Promise.resolve(new Map()),
    });
    await flush();
    expect(updateMessageActivity).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });
});
