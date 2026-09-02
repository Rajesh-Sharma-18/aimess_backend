import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import type { Redis } from "ioredis";

import {
  publishCommunityUpdated,
  publishConvUpdated,
} from "./publish-conv-updated.js";
import { registerUnreadSummaryPusher } from "./unread-summary-bridge.js";

/**
 * One message into an N-member room used to ask the nav-badge bridge for a
 * summary once PER RECIPIENT, and each summary is three collection-wide unread
 * aggregations — so a 25-member community send issued ~75 of them, measured as
 * 147 database operations for a single message against 16 for a 2-member room.
 *
 * These tests pin the shape that made it flat: the bridge is called ONCE per
 * publish, carrying every affected recipient, so the pusher can resolve them
 * together. A regression here is silent and only shows up as latency, so it is
 * asserted on the call COUNT, not on wall-clock.
 */
function makeFakeRedis() {
  const pipeline = {
    publish() {
      return pipeline;
    },
    async exec() {
      return [];
    },
  };
  return { pipeline: () => pipeline } as unknown as Redis;
}

/** Captures every batch handed to the bridge. */
function capturePusher(): string[][] {
  const batches: string[][] = [];
  registerUnreadSummaryPusher((userIds) => {
    batches.push([...userIds]);
  });
  return batches;
}

const PREVIEW = { contentType: "TEXT", text: "hello" };

describe("nav-badge fan-out is batched, not per recipient", () => {
  let batches: string[][];

  beforeEach(() => {
    batches = capturePusher();
  });

  it("publishConvUpdated notifies the bridge once for all unread recipients", async () => {
    const recipientIds = Array.from({ length: 25 }, (_, i) => `u${i}`);

    await publishConvUpdated({
      redis: makeFakeRedis(),
      type: "GROUP",
      roomId: "grp_batch",
      recipientIds,
      // u0 is the sender: everyone else's badge moves, the sender's does not.
      senderId: "u0",
      senderName: "Sender",
      lastMessageId: "m1",
      lastMessageAt: 1_700_000_000_000,
      preview: PREVIEW,
    });

    assert.equal(
      batches.length,
      1,
      `expected ONE bridge call, got ${batches.length} — the per-recipient call was reintroduced`
    );
    assert.deepEqual(batches[0], recipientIds.slice(1));
  });

  it("publishCommunityUpdated notifies the bridge once for all members", async () => {
    const memberIds = Array.from({ length: 25 }, (_, i) => `c${i}`);

    await publishCommunityUpdated({
      redis: makeFakeRedis(),
      communityId: "com_batch",
      roomId: "room_batch",
      memberIds,
      senderId: "c0",
      senderName: "Sender",
      lastMessageId: "m1",
      lastMessageAt: 1_700_000_000_000,
      preview: PREVIEW,
    });

    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0], memberIds.slice(1));
  });

  it("does not call the bridge at all when no badge moved", async () => {
    await publishConvUpdated({
      redis: makeFakeRedis(),
      type: "GROUP",
      roomId: "grp_system",
      recipientIds: ["u1", "u2"],
      senderId: "",
      senderName: "",
      lastMessageId: "m1",
      lastMessageAt: 1_700_000_000_000,
      // SYSTEM lines carry no sender and must never raise a badge.
      preview: { contentType: "SYSTEM", text: "Ann joined" },
    });

    assert.equal(batches.length, 0);
  });

  it("still notifies the bridge when the Redis publish fails", async () => {
    const failing = {
      pipeline: () => ({
        publish() {
          return this;
        },
        async exec() {
          throw new Error("redis down");
        },
      }),
    } as unknown as Redis;

    await publishConvUpdated({
      redis: failing,
      type: "GROUP",
      roomId: "grp_fail",
      recipientIds: ["u0", "u1", "u2"],
      senderId: "u0",
      senderName: "Sender",
      lastMessageId: "m1",
      lastMessageAt: 1_700_000_000_000,
      preview: PREVIEW,
    });

    // The bump and the badge refresh are independent effects — losing Redis
    // must not also cost every recipient their nav-badge total.
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0], ["u1", "u2"]);
  });
});
