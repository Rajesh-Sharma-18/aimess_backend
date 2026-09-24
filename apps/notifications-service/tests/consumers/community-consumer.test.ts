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

// Mock the community gRPC client — the authoritative community-name source for
// every payload that does not carry `communityName` (moderation, invites,
// reports, lifecycle). Creating the real client would open a socket.
jest.mock("../../src/grpc/community.client.js", () => ({
  communityClient: { getCommunityBrief: jest.fn(async () => null) },
}));

import { CommunityEvents } from "@aimess/shared-types";
import { publishUserSocketEvent } from "@aimess/redis";

import { startCommunityConsumer } from "../../src/consumers/community.consumer.js";
import { communityClient } from "../../src/grpc/community.client.js";
import { pushToUser, pushToUsers } from "../../src/services/push.service.js";

const push = pushToUser as jest.Mock;
const pushMany = pushToUsers as jest.Mock;
const pubSocket = publishUserSocketEvent as jest.Mock;
const getBrief = communityClient.getCommunityBrief as jest.Mock;

/** Community-service answers with the CURRENT name for that id. */
function communityDirectory(byId: Record<string, string>): void {
  getBrief.mockImplementation(async (communityId: string) =>
    byId[communityId]
      ? { communityId, name: byId[communityId], avatarUrl: "" }
      : null
  );
}

beforeEach(() => {
  getBrief.mockReset();
  getBrief.mockResolvedValue(null);
});

const CID = "c".repeat(24);
const RID = "r".repeat(24);
const REQUESTER = "99999999-9999-4999-8999-999999999999";
const MOD = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const MOD_2 = "33333333-3333-4333-8333-333333333333";

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
    expect(arg.copy("en").title).toBe("Cool Community");
    expect(arg.copy("en").body).toBe(
      "Someone approved your request to join Cool Community"
    );
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
    expect(arg.copy("en").title).toBe("Cool Community");
    expect(arg.copy("en").body).toBe(
      "Your request to join Cool Community wasn't approved"
    );
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

describe("JOIN_REQUESTED branch — admin-only recipient set", () => {
  const JOIN_REQUESTED = {
    communityId: CID,
    communityName: "Cool Community",
    communityHandle: "@coolcommunity",
    communityAvatarUrl: null,
    userId: REQUESTER,
    requestId: RID,
    message: null,
    requesterDisplayName: "Alice Requester",
    requesterAvatarUrl: null,
    eventAt: "2026-09-24T10:00:00.000Z",
  };

  it("pushes to the admin(s) only — every moderator is absent from the recipient set", async () => {
    await deliver(CommunityEvents.JOIN_REQUESTED, {
      ...JOIN_REQUESTED,
      adminRecipientIds: [ADMIN],
    });

    expect(pushMany).toHaveBeenCalledTimes(1);
    const recipients = pushMany.mock.calls[0][0] as string[];
    expect(recipients).toEqual([ADMIN]);
    // One assertion per excluded party, so a failure names who leaked.
    expect(recipients).not.toContain(MOD);
    expect(recipients).not.toContain(MOD_2);
    expect(recipients).not.toContain(REQUESTER);
    // pushToUser is the single-recipient seam — nothing may sneak a moderator
    // in through it either.
    expect(push).not.toHaveBeenCalled();
  });

  it("ignores a legacy moderatorRecipientIds field rather than falling back to it", async () => {
    // An old producer's in-flight message, or a hand-rolled replay. The wide
    // roster must NOT be honoured: dropping one admin notification during a
    // rollout is recoverable, notifying every moderator is the bug.
    await deliver(CommunityEvents.JOIN_REQUESTED, {
      ...JOIN_REQUESTED,
      moderatorRecipientIds: [ADMIN, MOD, MOD_2],
    });

    expect(pushMany).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("drops the event when the only 'admin' is the requester (no self-notification)", async () => {
    await deliver(CommunityEvents.JOIN_REQUESTED, {
      ...JOIN_REQUESTED,
      adminRecipientIds: [REQUESTER],
    });

    expect(pushMany).not.toHaveBeenCalled();
  });

  it("notifies every co-admin when ownership is shared, still no moderators", async () => {
    const ADMIN_2 = "44444444-4444-4444-8444-444444444444";
    await deliver(CommunityEvents.JOIN_REQUESTED, {
      ...JOIN_REQUESTED,
      adminRecipientIds: [ADMIN, ADMIN_2],
    });

    const recipients = pushMany.mock.calls[0][0] as string[];
    expect(recipients.sort()).toEqual([ADMIN, ADMIN_2].sort());
  });
});

describe("JOIN_REQUEST_RETRACTED branch — the admin's card goes away", () => {
  const RETRACTED = {
    communityId: CID,
    eventAt: "2026-09-24T11:00:00.000Z",
    requestId: RID,
    requesterId: REQUESTER,
    resolution: "APPROVED" as const,
    adminRecipientIds: [ADMIN],
  };

  it("removes the row for the admin(s) only, silently and regardless of settings", async () => {
    await deliver(CommunityEvents.JOIN_REQUEST_RETRACTED, RETRACTED);

    expect(pushMany).toHaveBeenCalledTimes(1);
    const [recipients, build] = pushMany.mock.calls[0] as [
      string[],
      (id: string) => Record<string, unknown>,
    ];
    expect(recipients).toEqual([ADMIN]);
    expect(recipients).not.toContain(MOD);
    expect(recipients).not.toContain(MOD_2);

    const arg = build(ADMIN);
    // No device may ring for "the request you handled is gone"...
    expect(arg.skipPush).toBe(true);
    // ...but the row must still be cleaned up for an admin who muted the
    // community, or their badge is stranded.
    expect(arg.bypassSettings).toBe(true);
    // The group key is the whole mechanism — it is what chat-service matches the
    // existing card on, and it must key on the REQUESTER (request ids recycle).
    expect((arg.data as Record<string, string>).groupKey).toBe(
      `community:${CID}:join_request:${REQUESTER}`
    );
  });

  it("matches the group key the JOIN_REQUESTED card was written under", async () => {
    await deliver(CommunityEvents.JOIN_REQUESTED, {
      communityId: CID,
      communityName: "Cool Community",
      communityHandle: "@cool",
      communityAvatarUrl: null,
      userId: REQUESTER,
      requestId: RID,
      message: null,
      requesterDisplayName: "Alice Requester",
      requesterAvatarUrl: null,
      eventAt: "2026-09-24T10:00:00.000Z",
      adminRecipientIds: [ADMIN],
    });
    const requestedData = (
      pushMany.mock.calls[0][1] as (id: string) => { data: Record<string, string> }
    )(ADMIN).data;

    await deliver(CommunityEvents.JOIN_REQUEST_RETRACTED, RETRACTED);
    const retractedData = (
      pushMany.mock.calls.at(-1)![1] as (id: string) => {
        data: Record<string, string>;
      }
    )(ADMIN).data;

    // The request's own row carries no explicit groupKey — chat-service derives
    // it from `requesterId` — so the retraction's explicit key has to agree with
    // that derivation. Assert the input they share.
    expect(requestedData.requesterId).toBe(REQUESTER);
    expect(requestedData.communityId).toBe(CID);
    expect(retractedData.groupKey).toBe(
      `community:${requestedData.communityId}:join_request:${requestedData.requesterId}`
    );
  });

  it("does nothing when the payload names no admin", async () => {
    await deliver(CommunityEvents.JOIN_REQUEST_RETRACTED, {
      ...RETRACTED,
      adminRecipientIds: [],
    });
    expect(pushMany).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it.each(["APPROVED", "REJECTED", "CANCELLED", "AUTO_RESOLVED"])(
    "retracts on %s — every resolution path clears the card",
    async (resolution) => {
      await deliver(CommunityEvents.JOIN_REQUEST_RETRACTED, {
        ...RETRACTED,
        resolution,
      });
      expect(pushMany).toHaveBeenCalledTimes(1);
      const arg = (pushMany.mock.calls[0][1] as (id: string) => Record<string, unknown>)(
        ADMIN
      );
      expect((arg.data as Record<string, string>).resolution).toBe(resolution);
    }
  );
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
    expect(arg.copy("en").title).toBe("Your community");
    expect(arg.copy("en").body).toBe("You were added to Your community");
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

describe("REPORT_CREATED branch", () => {
  const REPORT_PAYLOAD = {
    communityId: CID,
    eventAt: "2026-08-14T10:00:00.000Z",
    reportId: "report-1",
    reporterId: MOD,
    targetUserId: REQUESTER,
    reason: "SPAM",
    communityName: "Cool Community",
    communityAvatarUrl: "https://cdn.example.com/cool.png",
  };

  it("excludes the reporter from the review push and names the community", async () => {
    await deliver(CommunityEvents.REPORT_CREATED, {
      ...REPORT_PAYLOAD,
      moderatorRecipientIds: [MOD, "moderator-2"],
    });

    expect(pushMany).toHaveBeenCalledTimes(1);
    const [recipients, build] = pushMany.mock.calls[0] as [
      string[],
      (id: string) => { copy: (l: string) => { title: string; body: string } },
    ];
    expect(recipients).toEqual(["moderator-2"]);
    const arg = build("moderator-2");
    expect(arg.copy("en").title).toBe("Cool Community");
    expect(arg.copy("en").body).toBe("A new report needs review.");
  });

  it("sends nothing when the reporter is the only moderator", async () => {
    await deliver(CommunityEvents.REPORT_CREATED, {
      ...REPORT_PAYLOAD,
      moderatorRecipientIds: [MOD],
    });

    expect(pushMany).not.toHaveBeenCalled();
  });
});

describe("MEMBER_UNBANNED branch", () => {
  it("titles the push with the community and drops the redundant body", async () => {
    await deliver(CommunityEvents.MEMBER_UNBANNED, {
      communityId: CID,
      eventAt: "2026-08-14T10:00:00.000Z",
      actorId: MOD,
      targetUserId: REQUESTER,
      communityName: "Vasundhara Community",
      communityAvatarUrl: "https://cdn.example.com/v.png",
    });

    expect(push).toHaveBeenCalledTimes(1);
    const arg = push.mock.calls[0][0];
    expect(arg.userId).toBe(REQUESTER);
    expect(arg.copy("en").title).toBe("Vasundhara Community");
    expect(arg.copy("en").body).toBe("Your ban has been lifted.");
    expect(arg.data.communityAvatarUrl).toBe("https://cdn.example.com/v.png");
  });
});

// ---------------------------------------------------------------------------
// Community-name resolution — the "Your community" placeholder regression.
//
// The moderation/invite/report/lifecycle payloads never carried
// `communityName`, so their pushes titled on the NOTIF_UNNAMED_COMMUNITY
// placeholder ("Your community"), which reads as a real community name. The
// consumer now resolves the name from the authoritative Community record.
// ---------------------------------------------------------------------------

describe("community name resolution", () => {
  const CID_B = "b".repeat(24);

  const roleChange = (communityId: string) => ({
    communityId,
    eventAt: "2026-08-17T10:00:00.000Z",
    actorId: MOD,
    targetUserId: REQUESTER,
    oldRole: "MEMBER",
    newRole: "MODERATOR",
  });

  it("MEMBER_ROLE_CHANGED — names the community instead of 'Your community'", async () => {
    communityDirectory({ [CID]: "Vasundhara Community" });
    await deliver(CommunityEvents.MEMBER_ROLE_CHANGED, roleChange(CID));

    expect(getBrief).toHaveBeenCalledWith(CID);
    const arg = push.mock.calls[0][0];
    expect(arg.userId).toBe(REQUESTER);
    expect(arg.copy("en").title).toBe("Vasundhara Community");
    expect(arg.copy("en").body).toBe(
      "You're now a moderator in Vasundhara Community"
    );
    // The FCM data payload + navigation object carry it too, for the tap target.
    expect(arg.data.communityName).toBe("Vasundhara Community");
    expect(JSON.parse(arg.data.navigation).communityName).toBe(
      "Vasundhara Community"
    );
  });

  it("resolves the community of the EVENT, not the user's other communities", async () => {
    communityDirectory({
      [CID]: "Vasundhara Community",
      [CID_B]: "Mot u Patlu Community",
    });
    await deliver(CommunityEvents.MEMBER_ROLE_CHANGED, roleChange(CID_B));

    expect(push.mock.calls[0][0].copy("en").title).toBe(
      "Mot u Patlu Community"
    );
  });

  it("uses the CURRENT name after a rename (resolved per event, never cached)", async () => {
    communityDirectory({ [CID]: "Renamed Community" });
    await deliver(CommunityEvents.MEMBER_ROLE_CHANGED, roleChange(CID));

    expect(push.mock.calls[0][0].copy("en").body).toBe(
      "You're now a moderator in Renamed Community"
    );
  });

  it("falls back to the payload name when the record cannot be reached", async () => {
    // Authoritative-FIRST: the lookup always runs (that is what makes a rename
    // visible on the very next push). The emit-time name is the fallback, not
    // a short-circuit.
    communityDirectory({});
    await deliver(CommunityEvents.MEMBER_BANNED, {
      communityId: CID,
      eventAt: "2026-08-17T10:00:00.000Z",
      actorId: MOD,
      targetUserId: REQUESTER,
      communityName: "Vasundhara Community",
      communityAvatarUrl: null,
    });

    expect(getBrief).toHaveBeenCalledWith(CID);
    expect(push.mock.calls[0][0].copy("en").title).toBe("Vasundhara Community");
  });

  it("still delivers a generic push when the community cannot be resolved", async () => {
    // Unknown id / community-service outage: fail open on the NAME only — the
    // push must not be dropped, and no name may be fabricated.
    communityDirectory({});
    await deliver(CommunityEvents.MEMBER_ROLE_CHANGED, roleChange(CID));

    expect(push).toHaveBeenCalledTimes(1);
    // Field is OMITTED rather than "" — no empty string reaches the client.
    expect(push.mock.calls[0][0].data.communityName).toBeUndefined();
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
    adminRecipientIds: [ADMIN],
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
    const { data } = builderFn(ADMIN);

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
    const { data } = builderFn(ADMIN);

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
    const { data } = builderFn(ADMIN);

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
    const { body } = builderFn(ADMIN).copy("en");

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
    expect(arg.copy("en").body).toContain("Mod McApprover");
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
