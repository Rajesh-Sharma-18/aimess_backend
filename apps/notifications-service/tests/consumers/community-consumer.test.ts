/**
 * Consumer regression for commit e21dede — notifications-service
 * `community.consumer.ts` JOIN_REQUEST_APPROVED / JOIN_REQUEST_REJECTED branches
 * and the MEMBER_ADDED welcome-skip + moderator fan-out.
 *
 * `handleCommunityEvent` is module-internal, so we drive it through the real
 * public seam: `startCommunityConsumer()` wires a `channel.consume` callback,
 * which we capture (amqplib is faked) and feed `{ type, data }` envelopes. We
 * assert on the mocked push.service (`pushToUser`/`pushToUsers`) and the mocked
 * `@aimess/redis` realtime publisher (`publishUserSocketEvent`).
 *
 * Verifies:
 *   - APPROVED/REJECTED → pushToUser the REQUESTER (correct copy) AND emit the
 *     realtime `community:join_request:update` socket event for the FE state-flip.
 *   - MEMBER_ADDED via join_request_approved → DOES NOT welcome the joiner (the
 *     dedicated approved push already covers it) and informs admins/mods,
 *     EXCLUDING the actor + the joined member.
 *   - MEMBER_ADDED via a non-approval path → DOES welcome the joiner.
 */

// Fake amqplib: capture the consume callback so we can inject messages.
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

// Mock push.service (the FCM/inbox boundary) — assert recipients + copy.
jest.mock("../../src/services/push.service.js", () => ({
  pushToUser: jest.fn(async () => undefined),
  pushToUsers: jest.fn(async () => undefined),
}));

// Mock @aimess/redis — assert the realtime socket event publisher is invoked.
jest.mock("@aimess/redis", () => ({
  publishUserSocketEvent: jest.fn(async () => 1),
}));

import { CommunityEvents } from "@aimess/shared-types";
import { publishUserSocketEvent } from "@aimess/redis";

import { startCommunityConsumer } from "../../src/consumers/community.consumer.js";
import { pushToUser, pushToUsers } from "../../src/services/push.service.js";

const push = pushToUser as jest.Mock;
const pushMany = pushToUsers as jest.Mock;
const pubSocket = publishUserSocketEvent as jest.Mock;

const CID = "c".repeat(24);
const RID = "r".repeat(24);
const REQUESTER = "99999999-9999-4999-8999-999999999999";
const MOD = "11111111-1111-4111-8111-111111111111";

/**
 * Boot the consumer, grab the captured consume callback, then deliver one
 * `{ type, data }` envelope and await the async handler to settle.
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

describe("JOIN_REQUEST_APPROVED branch", () => {
  const payload = {
    communityId: CID,
    communityName: "Cool Community",
    requestId: RID,
    userId: REQUESTER,
    decidedBy: { userId: MOD, username: null },
    decidedAt: "2026-06-16T10:00:00.000Z",
    eventAt: "2026-06-16T10:00:00.000Z",
  };

  it("pushes an 'approved' notification to the requester", async () => {
    await deliver(CommunityEvents.JOIN_REQUEST_APPROVED, payload);

    expect(push).toHaveBeenCalledTimes(1);
    const arg = push.mock.calls[0][0];
    expect(arg.userId).toBe(REQUESTER);
    expect(arg.title).toBe("Join request approved");
    expect(arg.body).toContain("Cool Community");
    expect(arg.data).toMatchObject({ requestId: RID, status: "APPROVED" });
  });

  it("emits the realtime community:join_request:update socket event", async () => {
    await deliver(CommunityEvents.JOIN_REQUEST_APPROVED, payload);

    expect(pubSocket).toHaveBeenCalledTimes(1);
    const [, userId, event, data] = pubSocket.mock.calls[0];
    expect(userId).toBe(REQUESTER);
    expect(event).toBe("community:join_request:update");
    expect(data).toMatchObject({
      communityId: CID,
      requestId: RID,
      status: "APPROVED",
      communityName: "Cool Community",
    });
  });
});

describe("JOIN_REQUEST_REJECTED branch", () => {
  const payload = {
    communityId: CID,
    communityName: "Cool Community",
    requestId: RID,
    userId: REQUESTER,
    decidedBy: { userId: MOD, username: null },
    decidedAt: "2026-06-16T10:00:00.000Z",
    eventAt: "2026-06-16T10:00:00.000Z",
  };

  it("pushes a 'declined' notification to the requester", async () => {
    await deliver(CommunityEvents.JOIN_REQUEST_REJECTED, payload);

    expect(push).toHaveBeenCalledTimes(1);
    const arg = push.mock.calls[0][0];
    expect(arg.userId).toBe(REQUESTER);
    expect(arg.title).toBe("Join request declined");
    expect(arg.body).toContain("Cool Community");
    expect(arg.data).toMatchObject({ requestId: RID, status: "REJECTED" });
  });

  it("emits the realtime community:join_request:update with REJECTED status", async () => {
    await deliver(CommunityEvents.JOIN_REQUEST_REJECTED, payload);

    expect(pubSocket).toHaveBeenCalledTimes(1);
    const [, userId, event, data] = pubSocket.mock.calls[0];
    expect(userId).toBe(REQUESTER);
    expect(event).toBe("community:join_request:update");
    expect(data.status).toBe("REJECTED");
  });
});

describe("MEMBER_ADDED branch", () => {
  it("does NOT welcome the joiner when via=join_request_approved", async () => {
    await deliver(CommunityEvents.MEMBER_ADDED, {
      communityId: CID,
      eventAt: "2026-06-16T10:00:00.000Z",
      actorId: MOD,
      targetUserId: REQUESTER,
      via: "join_request_approved",
      requestId: RID,
      communityName: "Cool Community",
      moderatorRecipientIds: [MOD, "moderator-2"],
    });

    // The dedicated approved push owns the joiner notification — no welcome here.
    const welcomedJoiner = push.mock.calls.some(
      (c) => c[0].userId === REQUESTER
    );
    expect(welcomedJoiner).toBe(false);
  });

  it("welcomes the joiner when via is a non-approval path (add_members)", async () => {
    await deliver(CommunityEvents.MEMBER_ADDED, {
      communityId: CID,
      eventAt: "2026-06-16T10:00:00.000Z",
      actorId: MOD,
      targetUserId: REQUESTER,
      via: "add_members",
      moderatorRecipientIds: [MOD],
    });

    expect(push).toHaveBeenCalledTimes(1);
    const arg = push.mock.calls[0][0];
    expect(arg.userId).toBe(REQUESTER);
    expect(arg.title).toBe("Welcome to the community");
  });

  it("fans the moderator awareness push to admins/mods, excluding actor + joiner", async () => {
    await deliver(CommunityEvents.MEMBER_ADDED, {
      communityId: CID,
      eventAt: "2026-06-16T10:00:00.000Z",
      actorId: MOD,
      targetUserId: REQUESTER,
      via: "join_request_approved",
      requestId: RID,
      communityName: "Cool Community",
      // Roster includes the actor (MOD), the joiner (REQUESTER), and two others.
      moderatorRecipientIds: [MOD, REQUESTER, "moderator-2", "moderator-3"],
    });

    expect(pushMany).toHaveBeenCalledTimes(1);
    const recipients = pushMany.mock.calls[0][0] as string[];
    expect(recipients.sort()).toEqual(["moderator-2", "moderator-3"]);
    expect(recipients).not.toContain(MOD); // actor excluded
    expect(recipients).not.toContain(REQUESTER); // joined member excluded
  });

  it("does not fan to moderators when the only candidates are the actor + joiner", async () => {
    await deliver(CommunityEvents.MEMBER_ADDED, {
      communityId: CID,
      eventAt: "2026-06-16T10:00:00.000Z",
      actorId: MOD,
      targetUserId: REQUESTER,
      via: "join_request_approved",
      requestId: RID,
      communityName: "Cool Community",
      moderatorRecipientIds: [MOD, REQUESTER],
    });

    expect(pushMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Deep-link navigation tests (T8 — navigation + actorSnapshot in FCM data)
// ---------------------------------------------------------------------------

describe("community consumer — navigation deep-link", () => {
  const BASE_COMMUNITY = {
    communityId: CID,
    communityName: "Cool Community",
    communityHandle: "@coolcommunity",
    communityAvatarUrl: "https://cdn.example.com/cool.png",
  };

  const JOIN_REQUESTED_PAYLOAD = {
    ...BASE_COMMUNITY,
    userId: REQUESTER,
    requestId: RID,
    message: null,
    moderatorRecipientIds: [MOD, "moderator-2"],
    requesterDisplayName: "Alice Requester",
    requesterAvatarUrl: "https://cdn.example.com/alice.png",
    eventAt: "2026-06-17T10:00:00.000Z",
  };

  const APPROVED_PAYLOAD = {
    ...BASE_COMMUNITY,
    requestId: RID,
    userId: REQUESTER,
    decidedBy: {
      userId: MOD,
      username: "moduser",
      displayName: "Mod McApprover",
    },
    decidedAt: "2026-06-17T10:00:00.000Z",
    eventAt: "2026-06-17T10:00:00.000Z",
  };

  const REJECTED_PAYLOAD = {
    ...BASE_COMMUNITY,
    requestId: RID,
    userId: REQUESTER,
    decidedBy: {
      userId: MOD,
      username: "moduser",
      displayName: "Mod McRejector",
    },
    decidedAt: "2026-06-17T10:00:00.000Z",
    eventAt: "2026-06-17T10:00:00.000Z",
  };

  // --- Test 1: JOIN_REQUESTED ---

  it("JOIN_REQUESTED — navigation JSON string in FCM data resolves to COMMUNITY_REQUESTS screen", async () => {
    await deliver(CommunityEvents.JOIN_REQUESTED, JOIN_REQUESTED_PAYLOAD);

    expect(pushMany).toHaveBeenCalledTimes(1);
    // pushToUsers(recipientIds, builderFn) — call the builder for one recipient
    const [, builderFn] = pushMany.mock.calls[0] as [
      string[],
      (id: string) => { data: Record<string, string> },
    ];
    const { data } = builderFn(MOD);

    // navigation must be a JSON string
    expect(typeof data.navigation).toBe("string");
    const nav = JSON.parse(data.navigation);
    expect(nav).toMatchObject({
      screen: "COMMUNITY_REQUESTS",
      communityId: CID,
      communityName: "Cool Community",
      communityHandle: "@coolcommunity",
      requestId: RID,
    });
  });

  it("JOIN_REQUESTED — actorSnapshot JSON string in FCM data contains requester info", async () => {
    await deliver(CommunityEvents.JOIN_REQUESTED, JOIN_REQUESTED_PAYLOAD);

    const [, builderFn] = pushMany.mock.calls[0] as [
      string[],
      (id: string) => { data: Record<string, string> },
    ];
    const { data } = builderFn(MOD);

    expect(typeof data.actorSnapshot).toBe("string");
    const actor = JSON.parse(data.actorSnapshot);
    expect(actor).toMatchObject({
      userId: REQUESTER,
      displayName: "Alice Requester",
      avatarUrl: "https://cdn.example.com/alice.png",
    });
  });

  it("JOIN_REQUESTED — FCM data has plain string communityName and requesterDisplayName", async () => {
    await deliver(CommunityEvents.JOIN_REQUESTED, JOIN_REQUESTED_PAYLOAD);

    const [, builderFn] = pushMany.mock.calls[0] as [
      string[],
      (id: string) => { data: Record<string, string> },
    ];
    const { data } = builderFn(MOD);

    expect(typeof data.communityName).toBe("string");
    expect(data.communityName).toBe("Cool Community");
    expect(typeof data.requesterDisplayName).toBe("string");
    expect(data.requesterDisplayName).toBe("Alice Requester");
  });

  it("JOIN_REQUESTED — push body contains requesterDisplayName and communityName", async () => {
    await deliver(CommunityEvents.JOIN_REQUESTED, JOIN_REQUESTED_PAYLOAD);

    const [, builderFn] = pushMany.mock.calls[0] as [
      string[],
      (id: string) => { body: string },
    ];
    const { body } = builderFn(MOD);

    expect(body).toContain("Alice Requester");
    expect(body).toContain("Cool Community");
  });

  // --- Test 2: JOIN_REQUEST_APPROVED ---

  it("JOIN_REQUEST_APPROVED — navigation JSON string in push data resolves to COMMUNITY_DETAILS screen", async () => {
    await deliver(CommunityEvents.JOIN_REQUEST_APPROVED, APPROVED_PAYLOAD);

    expect(push).toHaveBeenCalledTimes(1);
    const arg = push.mock.calls[0][0] as {
      data: Record<string, string>;
      body: string;
    };

    expect(typeof arg.data.navigation).toBe("string");
    const nav = JSON.parse(arg.data.navigation);
    expect(nav).toMatchObject({
      screen: "COMMUNITY_DETAILS",
      communityId: CID,
      communityName: "Cool Community",
      communityHandle: "@coolcommunity",
    });
  });

  it("JOIN_REQUEST_APPROVED — actorSnapshot JSON string in push data contains decidedBy info", async () => {
    await deliver(CommunityEvents.JOIN_REQUEST_APPROVED, APPROVED_PAYLOAD);

    const arg = push.mock.calls[0][0] as { data: Record<string, string> };
    expect(typeof arg.data.actorSnapshot).toBe("string");
    const actor = JSON.parse(arg.data.actorSnapshot);
    expect(actor).toMatchObject({
      userId: MOD,
      displayName: "Mod McApprover",
    });
  });

  it("JOIN_REQUEST_APPROVED — push body contains decidedBy.displayName", async () => {
    await deliver(CommunityEvents.JOIN_REQUEST_APPROVED, APPROVED_PAYLOAD);

    const arg = push.mock.calls[0][0] as { body: string };
    expect(arg.body).toContain("Mod McApprover");
  });

  it("JOIN_REQUEST_APPROVED — socket event payload navigation is a parsed OBJECT (not a string)", async () => {
    await deliver(CommunityEvents.JOIN_REQUEST_APPROVED, APPROVED_PAYLOAD);

    expect(pubSocket).toHaveBeenCalledTimes(1);
    const [, userId, event, data] = pubSocket.mock.calls[0];
    expect(userId).toBe(REQUESTER);
    expect(event).toBe("community:join_request:update");

    // navigation on the socket payload must be an object — not a JSON string
    expect(typeof data.navigation).toBe("object");
    expect(data.navigation).not.toBeNull();
    expect(data.navigation).toMatchObject({
      screen: "COMMUNITY_DETAILS",
      communityId: CID,
      communityName: "Cool Community",
    });
  });

  // --- Test 3: JOIN_REQUEST_REJECTED ---

  it("JOIN_REQUEST_REJECTED — navigation JSON string in push data resolves to COMMUNITY_DETAILS screen", async () => {
    await deliver(CommunityEvents.JOIN_REQUEST_REJECTED, REJECTED_PAYLOAD);

    expect(push).toHaveBeenCalledTimes(1);
    const arg = push.mock.calls[0][0] as { data: Record<string, string> };
    expect(typeof arg.data.navigation).toBe("string");
    const nav = JSON.parse(arg.data.navigation);
    expect(nav).toMatchObject({
      screen: "COMMUNITY_DETAILS",
      communityId: CID,
      communityName: "Cool Community",
    });
  });

  it("JOIN_REQUEST_REJECTED — actorSnapshot JSON string in push data contains decidedBy info", async () => {
    await deliver(CommunityEvents.JOIN_REQUEST_REJECTED, REJECTED_PAYLOAD);

    const arg = push.mock.calls[0][0] as { data: Record<string, string> };
    expect(typeof arg.data.actorSnapshot).toBe("string");
    const actor = JSON.parse(arg.data.actorSnapshot);
    expect(actor).toMatchObject({
      userId: MOD,
      displayName: "Mod McRejector",
    });
  });

  it("JOIN_REQUEST_REJECTED — socket event payload navigation is a parsed OBJECT with COMMUNITY_DETAILS", async () => {
    await deliver(CommunityEvents.JOIN_REQUEST_REJECTED, REJECTED_PAYLOAD);

    expect(pubSocket).toHaveBeenCalledTimes(1);
    const [, userId, event, data] = pubSocket.mock.calls[0];
    expect(userId).toBe(REQUESTER);
    expect(event).toBe("community:join_request:update");
    expect(data.status).toBe("REJECTED");

    expect(typeof data.navigation).toBe("object");
    expect(data.navigation).not.toBeNull();
    expect(data.navigation).toMatchObject({
      screen: "COMMUNITY_DETAILS",
      communityId: CID,
      communityName: "Cool Community",
    });
  });
});
