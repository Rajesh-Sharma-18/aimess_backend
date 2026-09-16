/**
 * Reactions must not touch a message's auto-delete deadline.
 *
 * The reported "disappearing message" was a message with seven reactions, so
 * the first suspicion was that reacting had moved its timer. It had not — but
 * nothing in the suite said so, and a reaction write is one careless `updatedAt`
 * away from either resetting the countdown or expiring the message on the spot.
 *
 * These pin the write payload itself: a reaction may change the stored reactor
 * map and the room's CHANGE revision, and nothing else. `createdAt` is the only
 * input to the deadline, and `autoDeleteAt` is the deadline.
 */
import { PrivateMessageRepository } from "../../src/repositories/private-message.repository.js";
import { GroupMessageRepository } from "../../src/repositories/group-message.repository.js";
import { GeneralRoomMessageRepository } from "../../src/repositories/general-room-message.repository.js";
import { computeAutoDeleteStamp } from "../../src/lib/auto-delete.js";
import { toggleStoredReaction } from "../../src/lib/chat-message.serializer.js";

/** Fields whose presence in a reaction write would move or void the timer. */
const TIMER_FIELDS = [
  "createdAt",
  "updatedAt",
  "autoDeleteAt",
  "autoDeleteAfterView",
  "autoDeleteNextAttemptAt",
  "autoDeleteClaimToken",
  "autoDeleteClaimedAt",
  "isDeleted",
  "deletedAt",
  "deletedType",
];

const capture = () => {
  const calls: Array<Record<string, unknown>> = [];
  const delegate = {
    updateMany: jest.fn(async (args: Record<string, any>) => {
      calls.push(args.data);
      return { count: 1 };
    }),
  };
  return { calls, delegate };
};

const roomRepoStub = { allocateRevision: jest.fn(async () => 42) } as never;

describe("a reaction write never carries a timer field", () => {
  const reactions = { "👍": [{ userId: "u1", userName: "", avatar: "", memberId: "" }] };

  it("private", async () => {
    const { calls, delegate } = capture();
    const repo = new PrivateMessageRepository(
      { privateMessage: delegate } as never,
      roomRepoStub
    );
    await repo.updateReactionsCas("m1", "prv_1", reactions, 7, {
      userId: "u1",
      emoji: "👍",
    });

    expect(Object.keys(calls[0]).sort()).toEqual(["reactions", "revision"]);
    for (const field of TIMER_FIELDS) expect(calls[0]).not.toHaveProperty(field);
  });

  it("group", async () => {
    const { calls, delegate } = capture();
    const repo = new GroupMessageRepository(
      { groupMessage: delegate } as never,
      roomRepoStub
    );
    await repo.updateReactionsCas("m1", "grp_1", reactions, 7, {
      userId: "u1",
      emoji: "👍",
    });

    expect(Object.keys(calls[0]).sort()).toEqual(["reactions", "revision"]);
    for (const field of TIMER_FIELDS) expect(calls[0]).not.toHaveProperty(field);
  });

  it("community", async () => {
    const { calls, delegate } = capture();
    const repo = new GeneralRoomMessageRepository({
      generalRoomMessage: delegate,
    } as never);
    await repo.updateReactionsCas("m1", reactions, 7, 8, "room_1", {
      userId: "u1",
      emoji: "👍",
    });

    expect(Object.keys(calls[0]).sort()).toEqual(["reactions", "revision"]);
    for (const field of TIMER_FIELDS) expect(calls[0]).not.toHaveProperty(field);
  });
});

describe("the deadline follows createdAt alone", () => {
  const TTL = 86_400;
  const setting = { mode: "TIMER" as const, ttlSeconds: TTL, setAt: "" };
  const createdAt = new Date("2026-09-15T09:41:22.585Z");

  it("is exactly createdAt plus the TTL, in absolute milliseconds", () => {
    const stamp = computeAutoDeleteStamp(setting, createdAt);
    expect(stamp.autoDeleteAt?.toISOString()).toBe("2026-09-16T09:41:22.585Z");
    expect(stamp.autoDeleteAt!.getTime() - createdAt.getTime()).toBe(TTL * 1000);
  });

  it("is not a calendar boundary — a late-evening message survives midnight", () => {
    const evening = new Date("2026-09-15T23:30:00.000Z");
    const stamp = computeAutoDeleteStamp(setting, evening);
    expect(stamp.autoDeleteAt?.toISOString()).toBe("2026-09-16T23:30:00.000Z");
  });

  it("treats the TTL as seconds, never as hours or milliseconds", () => {
    const stamp = computeAutoDeleteStamp(setting, createdAt);
    const hours = (stamp.autoDeleteAt!.getTime() - createdAt.getTime()) / 3_600_000;
    expect(hours).toBe(24);
  });

  it("does not move when reactors come and go", () => {
    const before = computeAutoDeleteStamp(setting, createdAt).autoDeleteAt!;

    let stored: unknown = {};
    for (const [userId, emoji] of [
      ["smiley", "❤️"],
      ["ironman", "❤️"],
      ["kristi", "👍"],
      ["tom", "👍"],
      ["peter", "👎"],
      ["spiderman", "😂"],
      ["other", "👏"],
    ] as const) {
      stored = toggleStoredReaction(stored, userId, emoji);
    }
    stored = toggleStoredReaction(stored, "tom", "👍");

    // Seven reactions in, one removed: the reactor map is the only thing that
    // changed, and recomputing from the unchanged createdAt gives the same
    // deadline it had before anyone reacted.
    expect(Object.values(stored as Record<string, unknown[]>).flat()).toHaveLength(6);
    expect(
      computeAutoDeleteStamp(setting, createdAt).autoDeleteAt!.getTime()
    ).toBe(before.getTime());
  });

  it("leaves a message with the timer OFF unstamped whatever happens to it", () => {
    const off = { mode: "OFF" as const, ttlSeconds: null, setAt: "" };
    expect(computeAutoDeleteStamp(off, createdAt).autoDeleteAt).toBeNull();
  });
});
