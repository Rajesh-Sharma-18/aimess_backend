/**
 * Bug 68 — the wire contract that makes a post-delete list bump survive.
 *
 * Clients keep a monotonic staleness guard on the list row ("ignore a bump older
 * than what I already show") so an out-of-order send can never drag a
 * conversation backwards. A delete recalc is the ONE legitimate backward move:
 * `lastMessageAt` points at the PREVIOUS visible message, or is 0 when nothing
 * visible remains. Without a marker saying so, every delete/clear bump was
 * silently discarded and the row kept the deleted message's timestamp and
 * preview until the next refetch.
 *
 * Also pins the two invariants a recalc must never violate: it must not raise an
 * unread badge, and (community) its `unreadDelta` must be paired with the
 * REMOVED message's id so a duplicated delivery cannot apply the delta twice.
 */
jest.mock("../../src/events/unread-summary-bridge.js", () => ({
  notifyUnreadChanged: jest.fn(),
  notifyUnreadChangedMany: jest.fn(),
}));

import {
  publishConvUpdated,
  publishCommunityUpdated,
} from "../../src/events/publish-conv-updated.js";
import { notifyUnreadChangedMany } from "../../src/events/unread-summary-bridge.js";

/**
 * The fan-out hands the nav-badge bridge ONE batch per publish rather than one
 * call per recipient (a 25-member send otherwise asked for 25 summaries, each
 * three collection-wide aggregations). These assertions still describe WHO gets
 * a badge refresh — only the delivery shape changed.
 */
const badgeRecipients = (): string[] =>
  (notifyUnreadChangedMany as jest.Mock).mock.calls.flatMap(
    (args) => args[0] as string[]
  );

const ROOM = "prv_1";
const COMMUNITY = "cmy_1";
const ALICE = "user-alice";
const BOB = "user-bob";
const DELETED_ID = "msg-that-was-deleted";
const PREV_ID = "msg-previous-visible";

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

const preview = { contentType: "TEXT", text: "the previous message" };

beforeEach(() => jest.clearAllMocks());

describe("conv:updated — delete recalc (private/group)", () => {
  it("marks the bump so the client's monotonic list guard lets it through", async () => {
    const { redis, forUser } = fakeRedis();

    await publishConvUpdated({
      redis,
      type: "PRIVATE",
      roomId: ROOM,
      recipientIds: [ALICE, BOB],
      senderId: BOB,
      lastMessageId: PREV_ID,
      lastMessageAt: 1_000,
      preview,
      deleteRecalc: true,
    });

    expect(forUser(ALICE)).toMatchObject({
      roomId: ROOM,
      lastMessageId: PREV_ID,
      lastMessageAt: 1_000,
      deleteRecalc: true,
    });
  });

  it("never raises an unread badge, even for a recipient who is not the sender", async () => {
    const { redis, forUser } = fakeRedis();

    await publishConvUpdated({
      redis,
      type: "PRIVATE",
      roomId: ROOM,
      recipientIds: [ALICE],
      senderId: BOB, // ALICE !== sender: a NORMAL bump would be unread:true here
      lastMessageId: PREV_ID,
      lastMessageAt: 1_000,
      preview,
      deleteRecalc: true,
    });

    expect(forUser(ALICE)).toMatchObject({ unread: false });
  });

  it("carries the authoritative absolute count so the badge is SET, not guessed", async () => {
    const { redis, forUser } = fakeRedis();

    await publishConvUpdated({
      redis,
      type: "PRIVATE",
      roomId: ROOM,
      recipientIds: [ALICE, BOB],
      senderId: BOB,
      lastMessageId: PREV_ID,
      lastMessageAt: 1_000,
      preview,
      deleteRecalc: true,
      unreadCountByRecipient: { [ALICE]: 4, [BOB]: 0 },
    });

    expect(forUser(ALICE)).toMatchObject({ unreadCount: 4 });
    expect(forUser(BOB)).toMatchObject({ unreadCount: 0 });
  });

  it("pushes the nav-badge total for every recipient — a delete moves it DOWN, which `unread` cannot signal", async () => {
    const { redis } = fakeRedis();

    await publishConvUpdated({
      redis,
      type: "PRIVATE",
      roomId: ROOM,
      recipientIds: [ALICE, BOB],
      senderId: BOB,
      lastMessageId: PREV_ID,
      lastMessageAt: 1_000,
      preview,
      deleteRecalc: true,
    });

    expect(badgeRecipients()).toEqual(expect.arrayContaining([ALICE, BOB]));
  });

  it("a NORMAL bump is unchanged — no marker, unread still computed", async () => {
    const { redis, forUser } = fakeRedis();

    await publishConvUpdated({
      redis,
      type: "PRIVATE",
      roomId: ROOM,
      recipientIds: [ALICE],
      senderId: BOB,
      lastMessageId: "msg-new",
      lastMessageAt: 5_000,
      preview,
    });

    expect(forUser(ALICE)).toMatchObject({ unread: true });
    expect(forUser(ALICE)).not.toHaveProperty("deleteRecalc");
  });
});

describe("community:updated — delete recalc", () => {
  it("marks the bump and applies the per-member unread delta", async () => {
    const { redis, forUser } = fakeRedis();

    await publishCommunityUpdated({
      redis,
      communityId: COMMUNITY,
      roomId: COMMUNITY,
      memberIds: [ALICE, BOB],
      senderId: BOB,
      senderName: "Bob",
      lastMessageId: PREV_ID,
      lastMessageAt: 1_000,
      preview,
      deleteRecalc: true,
      deleteRecalcId: DELETED_ID,
      unreadDeltaByMember: { [ALICE]: -1 }, // BOB had already read it
    });

    expect(forUser(ALICE)).toMatchObject({
      deleteRecalc: true,
      unreadDelta: -1,
      deleteRecalcId: DELETED_ID,
      unread: false,
    });
    // Unaffected member: marker yes, delta no.
    expect(forUser(BOB)).toMatchObject({ deleteRecalc: true });
    expect(forUser(BOB)).not.toHaveProperty("unreadDelta");
  });

  it("keys the delta on the REMOVED message, never the surviving one", async () => {
    // `lastMessageId` names the PREVIOUS visible message on a recalc, so using it
    // as the idempotency key would collide with that message's own bumps.
    const { redis, forUser } = fakeRedis();

    await publishCommunityUpdated({
      redis,
      communityId: COMMUNITY,
      roomId: COMMUNITY,
      memberIds: [ALICE],
      senderId: BOB,
      senderName: "Bob",
      lastMessageId: PREV_ID,
      lastMessageAt: 1_000,
      preview,
      deleteRecalc: true,
      deleteRecalcId: DELETED_ID,
      unreadDeltaByMember: { [ALICE]: -1 },
    });

    const data = forUser(ALICE)!;
    expect(data.deleteRecalcId).toBe(DELETED_ID);
    expect(data.deleteRecalcId).not.toBe(data.lastMessageId);
  });

  it("pushes the nav-badge total only for members whose count actually moved", async () => {
    const { redis } = fakeRedis();

    await publishCommunityUpdated({
      redis,
      communityId: COMMUNITY,
      roomId: COMMUNITY,
      memberIds: [ALICE, BOB],
      senderId: BOB,
      senderName: "Bob",
      lastMessageId: PREV_ID,
      lastMessageAt: 1_000,
      preview,
      deleteRecalc: true,
      unreadDeltaByMember: { [ALICE]: -1 },
    });

    expect(badgeRecipients()).toContain(ALICE);
    expect(badgeRecipients()).not.toContain(BOB);
  });

  it("an emptied room bumps with 0 — never a fabricated 'now' that pins it to the top", async () => {
    const { redis, forUser } = fakeRedis();

    await publishCommunityUpdated({
      redis,
      communityId: COMMUNITY,
      roomId: COMMUNITY,
      memberIds: [ALICE],
      senderId: "",
      senderName: "",
      lastMessageId: "",
      lastMessageAt: 0,
      preview: { contentType: "", text: "" },
      deleteRecalc: true,
    });

    expect(forUser(ALICE)).toMatchObject({
      lastMessageAt: 0,
      lastMessageId: "",
      deleteRecalc: true,
    });
  });

  it("a NORMAL community bump is unchanged", async () => {
    const { redis, forUser } = fakeRedis();

    await publishCommunityUpdated({
      redis,
      communityId: COMMUNITY,
      roomId: COMMUNITY,
      memberIds: [ALICE],
      senderId: BOB,
      senderName: "Bob",
      lastMessageId: "msg-new",
      lastMessageAt: 5_000,
      preview,
    });

    expect(forUser(ALICE)).toMatchObject({ unread: true });
    expect(forUser(ALICE)).not.toHaveProperty("deleteRecalc");
    expect(forUser(ALICE)).not.toHaveProperty("unreadDelta");
  });
});
