/**
 * Notification consumer tests for the `community.member_joined` (MEMBER_JOINED)
 * event — the dedicated self-join push added in the community join-flow overhaul.
 *
 * Mirrors the pattern in community-consumer.test.ts:
 *   - startCommunityConsumer() is booted, the channel.consume callback is
 *     captured, and we feed { type, data } envelopes to it directly.
 *   - Assertions are on the mocked pushToUser / pushToUsers + publishUserSocketEvent.
 *
 * Verifies:
 *   4.1 MEMBER_JOINED → pushToUser the joiner (userId), title = communityName,
 *       body contains communityName.
 *   4.2 MEMBER_ADDED via self_join → does NOT send a welcome push to the joiner
 *       (MEMBER_JOINED owns the welcome copy) but DOES fan to mods.
 */

// ---------------------------------------------------------------------------
// Fake amqplib — capture the consume callback for message injection.
// ---------------------------------------------------------------------------
const channelMock = {
  assertQueue: jest.fn(async () => undefined),
  prefetch: jest.fn(async () => undefined),
  consume: jest.fn(),
  ack: jest.fn(),
  nack: jest.fn(),
};
const connectionMock = {
  createChannel: jest.fn(async () => channelMock),
};
jest.mock("amqplib", () => ({
  __esModule: true,
  default: { connect: jest.fn(async () => connectionMock) },
  connect: jest.fn(async () => connectionMock),
}));

// Mock push.service — assert recipients + copy.
jest.mock("../../src/services/push.service.js", () => ({
  pushToUser: jest.fn(async () => undefined),
  pushToUsers: jest.fn(async () => undefined),
}));

// Mock @aimess/redis — assert realtime publisher is/isn't invoked.
jest.mock("@aimess/redis", () => ({
  publishUserSocketEvent: jest.fn(async () => 1),
}));

// ---------------------------------------------------------------------------
// Imports (after all jest.mock declarations)
// ---------------------------------------------------------------------------

import { CommunityEvents } from "@aimess/shared-types";
import { publishUserSocketEvent } from "@aimess/redis";

import { startCommunityConsumer } from "../../src/consumers/community.consumer.js";
import { pushToUser, pushToUsers } from "../../src/services/push.service.js";

// ---------------------------------------------------------------------------
// Typed aliases
// ---------------------------------------------------------------------------

const push = pushToUser as jest.Mock;
const pushMany = pushToUsers as jest.Mock;
const pubSocket = publishUserSocketEvent as jest.Mock;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const CID = "c".repeat(24);
const USER_ID = "99999999-9999-4999-8999-999999999999";
const MOD = "11111111-1111-4111-8111-111111111111";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Boot the consumer once, capture the channel.consume callback, feed a single
 * { type, data } envelope, and wait for the async handler to settle.
 */
async function deliver(type: string, data: unknown): Promise<void> {
  channelMock.consume.mockClear();
  await startCommunityConsumer();
  const onMessage = channelMock.consume.mock.calls[0][1] as (
    msg: { content: Buffer } | null
  ) => void;
  onMessage({ content: Buffer.from(JSON.stringify({ type, data })) });
  // Let the fire-and-forget async IIFE inside the consumer resolve.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// Test 4.1: MEMBER_JOINED → welcome push to the joiner
// ---------------------------------------------------------------------------

describe("MEMBER_JOINED branch", () => {
  const memberJoinedPayload = {
    communityId: CID,
    userId: USER_ID,
    communityName: "Cool Community",
    communityHandle: "@coolcommunity",
    communityAvatarUrl: "https://cdn.example.com/cool.png",
    reactivated: false,
    eventAt: "2026-06-17T12:00:00.000Z",
  };

  it("4.1 sends push notification to userId with correct title", async () => {
    await deliver(CommunityEvents.MEMBER_JOINED, memberJoinedPayload);

    expect(push).toHaveBeenCalledTimes(1);
    const arg = push.mock.calls[0][0];
    expect(arg.userId).toBe(USER_ID);
    expect(arg.copy("en").title).toBe("Cool Community");
  });

  it("4.1 push body contains the community name", async () => {
    await deliver(CommunityEvents.MEMBER_JOINED, memberJoinedPayload);

    expect(push).toHaveBeenCalledTimes(1);
    const arg = push.mock.calls[0][0];
    expect(arg.copy("en").body).toContain("Cool Community");
  });

  it("4.1 push data contains communityId and communityName", async () => {
    await deliver(CommunityEvents.MEMBER_JOINED, memberJoinedPayload);

    expect(push).toHaveBeenCalledTimes(1);
    const arg = push.mock.calls[0][0];
    expect(arg.data).toMatchObject({
      communityId: CID,
      communityName: "Cool Community",
    });
  });

  it("4.1 emits community:joined socket event to the joiner for real-time UI flip", async () => {
    await deliver(CommunityEvents.MEMBER_JOINED, memberJoinedPayload);

    expect(pubSocket).toHaveBeenCalledTimes(1);
    const [, userId, event, payload] = pubSocket.mock.calls[0];
    expect(userId).toBe(USER_ID);
    expect(event).toBe("community:joined");
    expect(payload).toMatchObject({
      communityId: CID,
      communityName: "Cool Community",
      reactivated: false,
    });
  });

  it("4.1 reactivated join — same push shape (body still contains communityName)", async () => {
    const reactivatedPayload = { ...memberJoinedPayload, reactivated: true };

    await deliver(CommunityEvents.MEMBER_JOINED, reactivatedPayload);

    expect(push).toHaveBeenCalledTimes(1);
    const arg = push.mock.calls[0][0];
    expect(arg.userId).toBe(USER_ID);
    expect(arg.copy("en").body).toContain("Cool Community");
  });
});

// ---------------------------------------------------------------------------
// Test 4.2: MEMBER_ADDED via self_join — no welcome push to joiner,
//           but moderator fan-out still fires.
// ---------------------------------------------------------------------------

describe("MEMBER_ADDED via self_join — no duplicate welcome push", () => {
  it("4.2 does NOT send a welcome push to the joiner (MEMBER_JOINED owns it)", async () => {
    await deliver(CommunityEvents.MEMBER_ADDED, {
      communityId: CID,
      eventAt: "2026-06-17T12:00:00.000Z",
      actorId: USER_ID,
      targetUserId: USER_ID,
      via: "self_join",
      communityName: "Cool Community",
      moderatorRecipientIds: [MOD, "moderator-2"],
    });

    // The joiner must NOT receive a welcome push on the MEMBER_ADDED path.
    const welcomedJoiner = push.mock.calls.some((c) => c[0].userId === USER_ID);
    expect(welcomedJoiner).toBe(false);
  });

  it("4.2 DOES fan moderator awareness push to mods (actor + joiner are the same, excluded)", async () => {
    await deliver(CommunityEvents.MEMBER_ADDED, {
      communityId: CID,
      eventAt: "2026-06-17T12:00:00.000Z",
      actorId: USER_ID,
      targetUserId: USER_ID,
      via: "self_join",
      communityName: "Cool Community",
      moderatorRecipientIds: [USER_ID, MOD, "moderator-2"],
    });

    // Moderator fan-out should include MOD and moderator-2 but NOT USER_ID.
    expect(pushMany).toHaveBeenCalledTimes(1);
    const recipients = pushMany.mock.calls[0][0] as string[];
    expect(recipients).not.toContain(USER_ID);
    expect(recipients).toContain(MOD);
    expect(recipients).toContain("moderator-2");
  });

  it("4.2 no pushToUsers when only the joiner is in the moderator list", async () => {
    await deliver(CommunityEvents.MEMBER_ADDED, {
      communityId: CID,
      eventAt: "2026-06-17T12:00:00.000Z",
      actorId: USER_ID,
      targetUserId: USER_ID,
      via: "self_join",
      communityName: "Cool Community",
      moderatorRecipientIds: [USER_ID], // only the joiner — excluded, leaving 0
    });

    expect(pushMany).not.toHaveBeenCalled();
  });

  it("4.2 MEMBER_ADDED via add_members still welcomes the joiner (control case)", async () => {
    await deliver(CommunityEvents.MEMBER_ADDED, {
      communityId: CID,
      eventAt: "2026-06-17T12:00:00.000Z",
      actorId: MOD,
      targetUserId: USER_ID,
      via: "add_members",
      communityName: "Cool Community",
      moderatorRecipientIds: [MOD],
    });

    // Non-self_join / non-join_request_approved path DOES welcome the joiner.
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].userId).toBe(USER_ID);
    expect(push.mock.calls[0][0].copy("en").title).toBe("Cool Community");
  });
});
