/**
 * Idempotency coverage for CommunitySystemMessageService.
 *
 * `community.system_message` flows over an at-least-once RabbitMQ queue, so the
 * broker can REDELIVER the same event (e.g. ack lost on a connection blip). The
 * service must collapse a redelivered event into a no-op so the timeline never
 * shows a DUPLICATE system line (the "Community was updated" ×2 bug). The dedup
 * key is derived from the producer-stamped `eventAt`, which is stable across
 * redeliveries.
 *
 * Guarantees pinned here:
 *   1. First delivery → one row created with a deterministic clientMessageId
 *      dedup key, and the bump + redis publish + activity publish all fire once.
 *   2. Redelivery (pre-check finds the existing row) → NO create, NO bump,
 *      NO redis publish, NO activity publish.
 *   3. Concurrent redelivery (pre-check misses, insert hits the unique index) →
 *      duplicate-key error is swallowed; NO bump / publish; never throws.
 *   4. No `eventAt` (direct/local post) → no dedup key, classic single post.
 *
 * Pure unit test: every dependency is a hand-rolled mock.
 */

jest.mock("../../src/events/publish-community-activity.js", () => ({
  publishCommunityActivitySafe: jest.fn(),
}));

import { CommunitySystemMessageService } from "../../src/services/community-system-message.service.js";
import { publishCommunityActivitySafe } from "../../src/events/publish-community-activity.js";

const pubActivity = publishCommunityActivitySafe as jest.Mock;

const EVENT_AT = "2026-06-19T12:00:00.000Z";
const COMMUNITY_ID = "comm-1";

function makeService(
  opts: {
    findOneResult?: unknown;
    createImpl?: () => Promise<unknown>;
  } = {}
) {
  const createSystemMessage = jest.fn(
    opts.createImpl ??
      (async () => ({
        id: "msg-1",
        sentBy: "actor-1",
        senderName: "Admin",
        message: "Community info was updated",
        messageType: "SYSTEM",
        createdAt: new Date(EVENT_AT),
      }))
  );
  const findOne = jest.fn(async () => opts.findOneResult ?? null);
  const messageRepo = { findOne, createSystemMessage };

  const allocateSequence = jest.fn(async () => 7);
  const addLastestMessageToRoom = jest.fn(async () => undefined);
  const roomRepo = { allocateSequence, addLastestMessageToRoom };

  const cacheRepo = {};
  const userSnapshotService = {
    getUserSnapshotsMap: jest.fn(
      async () =>
        new Map<string, Record<string, unknown>>([
          ["actor-1", { displayName: "Admin" }],
        ])
    ),
  };

  const publish = jest.fn(async () => 1);
  const redis = { publish };

  const service = new CommunitySystemMessageService(
    messageRepo as any,

    roomRepo as any,

    cacheRepo as any,

    userSnapshotService as any,

    redis as any
  );

  return {
    service,
    findOne,
    createSystemMessage,
    allocateSequence,
    addLastestMessageToRoom,
    publish,
  };
}

beforeEach(() => {
  pubActivity.mockClear();
});

describe("CommunitySystemMessageService — idempotent post", () => {
  it("first delivery creates ONE row with a deterministic dedup key + fires effects", async () => {
    const h = makeService({ findOneResult: null });

    await h.service.post({
      communityId: COMMUNITY_ID,
      systemMessageType: "COMMUNITY_UPDATED",
      metadata: {},
      triggeredByUserId: "actor-1",
      eventAt: EVENT_AT,
    });

    expect(h.createSystemMessage).toHaveBeenCalledTimes(1);
    const arg = h.createSystemMessage.mock.calls[0][0] as {
      clientMessageId?: string;
    };
    expect(arg.clientMessageId).toBe(`sys:COMMUNITY_UPDATED:${EVENT_AT}`);
    // COMMUNITY_UPDATED bumps activity → list bump + activity event fire once.
    expect(h.addLastestMessageToRoom).toHaveBeenCalledTimes(1);
    expect(pubActivity).toHaveBeenCalledTimes(1);
    // community message:new published to the room channel.
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it("redelivery (pre-check finds the row) is a no-op: no create, no bump, no publish", async () => {
    const h = makeService({ findOneResult: { id: "existing" } });

    await h.service.post({
      communityId: COMMUNITY_ID,
      systemMessageType: "COMMUNITY_UPDATED",
      metadata: {},
      triggeredByUserId: "actor-1",
      eventAt: EVENT_AT,
    });

    expect(h.findOne).toHaveBeenCalledWith({
      roomId: COMMUNITY_ID,
      clientMessageId: `sys:COMMUNITY_UPDATED:${EVENT_AT}`,
    });
    expect(h.createSystemMessage).not.toHaveBeenCalled();
    expect(h.allocateSequence).not.toHaveBeenCalled();
    expect(h.addLastestMessageToRoom).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(pubActivity).not.toHaveBeenCalled();
  });

  it("concurrent redelivery (insert hits the unique index) swallows duplicate-key, no effects, never throws", async () => {
    const dupErr = Object.assign(new Error("E11000 duplicate key"), {
      code: 11000,
    });
    const h = makeService({
      findOneResult: null, // pre-check misses (race)
      createImpl: async () => {
        throw dupErr;
      },
    });

    await expect(
      h.service.post({
        communityId: COMMUNITY_ID,
        systemMessageType: "COMMUNITY_UPDATED",
        metadata: {},
        triggeredByUserId: "actor-1",
        eventAt: EVENT_AT,
      })
    ).resolves.toBeUndefined();

    expect(h.createSystemMessage).toHaveBeenCalledTimes(1);
    // Lost the race → the winning delivery already bumped/published.
    expect(h.addLastestMessageToRoom).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(pubActivity).not.toHaveBeenCalled();
  });

  it("dedup key includes the target user for membership events", async () => {
    const h = makeService({ findOneResult: null });

    await h.service.post({
      communityId: COMMUNITY_ID,
      systemMessageType: "MEMBER_BANNED",
      metadata: { targetUserId: "victim-9" },
      triggeredByUserId: "actor-1",
      eventAt: EVENT_AT,
    });

    const arg = h.createSystemMessage.mock.calls[0][0] as {
      clientMessageId?: string;
    };
    expect(arg.clientMessageId).toBe(`sys:MEMBER_BANNED:${EVENT_AT}:victim-9`);
  });

  it("without eventAt (direct/local post) there is no dedup key and no pre-check read", async () => {
    const h = makeService({ findOneResult: null });

    await h.service.post({
      communityId: COMMUNITY_ID,
      systemMessageType: "PINNED_MESSAGE",
      metadata: { pinnedMessageId: "m1" },
      triggeredByUserId: "actor-1",
      // no eventAt
    });

    expect(h.findOne).not.toHaveBeenCalled();
    expect(h.createSystemMessage).toHaveBeenCalledTimes(1);
    const arg = h.createSystemMessage.mock.calls[0][0] as {
      clientMessageId?: string | null;
    };
    expect(arg.clientMessageId).toBeNull();
  });
});
