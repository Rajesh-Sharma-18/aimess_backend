/**
 * Every PENDING attempt of a join request must reach the admin as its OWN
 * actionable card, and must stop being actionable the moment it is settled.
 *
 * The reported failure was that only the first attempt ever notified: request →
 * cancel → request again left the admin with nothing new. The card is grouped
 * per (community, requester) — the join request row is unique on that pair and
 * recycled, so the second attempt arrived under the identity of the first and
 * rewrote its row in place, which produces no new-notification event and no
 * badge. These assertions pin the two halves of the fix that live in this
 * service: the previous card is retracted BEFORE the new one is written, and
 * the new one carries the ids and the attempt token an Accept / Decline button
 * needs.
 */
const channelMock = {
  assertQueue: jest.fn(async () => undefined),
  prefetch: jest.fn(async () => undefined),
  consume: jest.fn(),
  ack: jest.fn(),
  nack: jest.fn(),
};
jest.mock("amqplib", () => ({
  __esModule: true,
  default: {
    connect: jest.fn(async () => ({ createChannel: jest.fn(async () => channelMock) })),
  },
  connect: jest.fn(async () => ({ createChannel: jest.fn(async () => channelMock) })),
}));
jest.mock("../../src/services/push.service.js", () => ({
  pushToUser: jest.fn(async () => undefined),
  pushToUsers: jest.fn(async () => undefined),
}));
jest.mock("@aimess/redis", () => ({ publishUserSocketEvent: jest.fn(async () => 1) }));
jest.mock("../../src/grpc/community.client.js", () => ({
  communityClient: { getCommunityBrief: jest.fn(async () => null) },
}));

import { CommunityEvents } from "@aimess/shared-types";

import { startCommunityConsumer } from "../../src/consumers/community.consumer.js";
import { pushToUsers } from "../../src/services/push.service.js";

const pushMany = pushToUsers as jest.Mock;

const CID = "c".repeat(24);
const RID = "r".repeat(24);
const ADMIN = "22222222-2222-4222-8222-222222222222";
const MOD = "11111111-1111-4111-8111-111111111111";
const REQUESTER = "99999999-9999-4999-8999-999999999999";
const GROUP_KEY = `community:${CID}:join_request:${REQUESTER}`;

async function deliver(type: string, data: unknown): Promise<void> {
  channelMock.consume.mockClear();
  await startCommunityConsumer();
  const onMessage = channelMock.consume.mock.calls[0][1] as (
    msg: { content: Buffer } | null
  ) => void;
  onMessage({ content: Buffer.from(JSON.stringify({ type, data })) });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

const requested = (over: Record<string, unknown> = {}) => ({
  communityId: CID,
  communityName: "Request Tester",
  communityHandle: "@requesttester",
  communityAvatarUrl: null,
  userId: REQUESTER,
  requestId: RID,
  lifecycle: `${RID}:1790000000000`,
  message: null,
  requesterDisplayName: "Mind Flayer",
  requesterAvatarUrl: null,
  eventAt: "2026-09-24T12:00:00.000Z",
  adminRecipientIds: [ADMIN],
  ...over,
});

/** The push built for one recipient, whichever call produced it. */
const built = (callIndex: number, userId = ADMIN) =>
  (pushMany.mock.calls[callIndex][1] as (id: string) => Record<string, unknown>)(userId);

describe("a new attempt supersedes the previous card", () => {
  it("retracts the previous card BEFORE writing the new one", async () => {
    await deliver(CommunityEvents.JOIN_REQUESTED, requested());

    // Two sends, in this order: the retraction, then the card. Reversed, the
    // retraction would delete the card it was meant to replace.
    expect(pushMany).toHaveBeenCalledTimes(2);
    const retraction = built(0);
    const card = built(1);
    expect(retraction.type).toBe(CommunityEvents.JOIN_REQUEST_RETRACTED);
    expect(card.type).toBe(CommunityEvents.JOIN_REQUESTED);
    expect((retraction.data as Record<string, string>).groupKey).toBe(GROUP_KEY);
  });

  it("does not wake a device for the superseding retraction", async () => {
    await deliver(CommunityEvents.JOIN_REQUESTED, requested());

    const retraction = built(0);
    // Silent, but still delivered: the data push is what lets a service worker
    // close the stale tray card. `skipPush` would leave that card behind.
    expect(retraction.dataOnly).toBe(true);
    expect(retraction.skipPush).toBeUndefined();
    expect(retraction.bypassSettings).toBe(true);
  });

  it("carries the ids and the attempt token an Accept / Decline needs", async () => {
    const lifecycle = `${RID}:1790000000999`;
    await deliver(CommunityEvents.JOIN_REQUESTED, requested({ lifecycle }));

    const data = built(1).data as Record<string, string>;
    expect(data.communityId).toBe(CID);
    expect(data.requesterId).toBe(REQUESTER);
    expect(data.joinRequestId).toBe(RID);
    // Kept alongside the new name so clients built against it keep working.
    expect(data.requestId).toBe(RID);
    expect(data.lifecycle).toBe(lifecycle);
  });

  it("offers Accept and Decline in the tray, in the reader's language", async () => {
    await deliver(CommunityEvents.JOIN_REQUESTED, requested());

    const card = built(1);
    const actions = (card.actions as (locale: string) => { action: string; title: string }[])(
      "en"
    );
    expect(actions.map((a) => a.action)).toEqual([
      "community_join_request_accept",
      "community_join_request_reject",
    ]);
    expect(actions.map((a) => a.title)).toEqual(["Accept", "Decline"]);
    // A Thai admin gets Thai buttons under a Thai sentence.
    const thai = (card.actions as (locale: string) => { title: string }[])("th");
    expect(thai[0].title).not.toBe("Accept");
    // iOS renders its own buttons off the registered category.
    expect(card.apnsCategory).toBe("COMMUNITY_JOIN_REQUEST");
  });

  it("tags the card so it can be closed by id rather than by its text", async () => {
    await deliver(CommunityEvents.JOIN_REQUESTED, requested());

    const tag = `community_join_request_${CID}_${REQUESTER}`;
    expect(built(1).collapseKey).toBe(tag);
    expect(built(0).collapseKey).toBe(tag);
  });

  it("still goes to the admin alone", async () => {
    await deliver(
      CommunityEvents.JOIN_REQUESTED,
      requested({ adminRecipientIds: [ADMIN] })
    );

    for (const call of pushMany.mock.calls) {
      const recipients = call[0] as string[];
      expect(recipients).toEqual([ADMIN]);
      expect(recipients).not.toContain(MOD);
      expect(recipients).not.toContain(REQUESTER);
    }
  });
});

describe("settling an attempt takes its card back", () => {
  const retracted = (over: Record<string, unknown> = {}) => ({
    communityId: CID,
    eventAt: "2026-09-24T12:05:00.000Z",
    requestId: RID,
    requesterId: REQUESTER,
    resolution: "CANCELLED",
    adminRecipientIds: [ADMIN],
    ...over,
  });

  it("stamps the retraction with the moment it was raised", async () => {
    await deliver(CommunityEvents.JOIN_REQUEST_RETRACTED, retracted());

    const data = built(0).data as Record<string, string>;
    // A cancel and the re-request behind it race through different queues. The
    // stamp is what stops a late retraction from deleting the card that
    // replaced the one it was written for.
    expect(data.staleBefore).toBe("2026-09-24T12:05:00.000Z");
    expect(data.groupKey).toBe(GROUP_KEY);
    expect(data.tag).toBe(`community_join_request_${CID}_${REQUESTER}`);
  });

  it.each(["APPROVED", "REJECTED", "CANCELLED", "AUTO_RESOLVED"])(
    "takes the card back however the attempt ended (%s)",
    async (resolution) => {
      await deliver(CommunityEvents.JOIN_REQUEST_RETRACTED, retracted({ resolution }));

      expect(pushMany).toHaveBeenCalledTimes(1);
      expect((built(0).data as Record<string, string>).resolution).toBe(resolution);
    }
  );

  it("does nothing when the payload names no admin", async () => {
    await deliver(
      CommunityEvents.JOIN_REQUEST_RETRACTED,
      retracted({ adminRecipientIds: [] })
    );
    expect(pushMany).not.toHaveBeenCalled();
  });
});
