import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { logger } from "@aimess/logger";

import type { Redis } from "ioredis";

import {
  publishCommunityUpdated,
  publishConvUpdated,
} from "./publish-conv-updated.js";

/**
 * Records every `.publish(channel, payload)` call routed through a pipeline.
 * `failExec` lets a test force `pipeline.exec()` to reject so the best-effort
 * (never-throw) path can be exercised.
 */
interface PublishCall {
  channel: string;
  payload: string;
}

function makeFakeRedis(opts: { failExec?: boolean } = {}) {
  const publishCalls: PublishCall[] = [];
  let pipelineCount = 0;

  const pipeline = {
    publish(channel: string, payload: string) {
      publishCalls.push({ channel, payload });
      return pipeline;
    },
    async exec() {
      if (opts.failExec) {
        throw new Error("boom");
      }
      return [];
    },
  };

  const redis = {
    pipeline() {
      pipelineCount += 1;
      return pipeline;
    },
  };

  return {
    // Cast through unknown: the helper only ever touches `.pipeline().publish/exec`.
    redis: redis as unknown as Redis,
    publishCalls,
    get pipelineCount() {
      return pipelineCount;
    },
  };
}

/** Capture `logger.warn` calls without printing during the test run. */
function spyOnLoggerWarn() {
  const calls: unknown[][] = [];
  const original = logger.warn.bind(logger);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (logger as any).warn = (...args: unknown[]) => {
    calls.push(args);
    return logger;
  };
  return {
    calls,
    restore() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (logger as any).warn = original;
    },
  };
}

describe("publishConvUpdated", () => {
  const basePreview = { contentType: "text", text: "hi" };

  it("publishes one message per recipient to user:<id>", async () => {
    const fake = makeFakeRedis();
    const { redis, publishCalls } = fake;

    await publishConvUpdated({
      redis,
      type: "GROUP",
      roomId: "room-1",
      recipientIds: ["u1", "u2", "u3"],
      senderId: "u1",
      lastMessageId: "m-1",
      lastMessageAt: 1717000000000,
      preview: basePreview,
    });

    assert.equal(fake.pipelineCount, 1, "exactly one pipeline used");
    assert.equal(publishCalls.length, 3, "one publish per recipient");
    assert.deepEqual(
      publishCalls.map((c) => c.channel),
      ["user:u1", "user:u2", "user:u3"]
    );
  });

  it("builds the correct payload shape and unread flag", async () => {
    const { redis, publishCalls } = makeFakeRedis();

    await publishConvUpdated({
      redis,
      type: "PRIVATE",
      roomId: "room-x",
      recipientIds: ["sender", "other"],
      senderId: "sender",
      lastMessageId: "msg-9",
      lastMessageAt: 1717000000123,
      preview: { contentType: "image", text: "pic" },
    });

    const senderMsg = JSON.parse(
      publishCalls.find((c) => c.channel === "user:sender")!.payload
    );
    const otherMsg = JSON.parse(
      publishCalls.find((c) => c.channel === "user:other")!.payload
    );

    assert.equal(senderMsg.event, "conv:updated");
    assert.equal(senderMsg.data.type, "PRIVATE");
    assert.equal(senderMsg.data.roomId, "room-x");
    assert.equal(senderMsg.data.lastMessageId, "msg-9");
    assert.equal(typeof senderMsg.data.lastMessageAt, "number");
    assert.equal(senderMsg.data.lastMessageAt, 1717000000123);
    assert.deepEqual(senderMsg.data.lastMessage, {
      contentType: "image",
      text: "pic",
    });
    // unread is false for the sender, true for everyone else
    assert.equal(senderMsg.data.unread, false);
    assert.equal(otherMsg.data.unread, true);
    assert.equal(otherMsg.event, "conv:updated");
  });

  it("de-dupes duplicate recipient ids to a single publish", async () => {
    const { redis, publishCalls } = makeFakeRedis();

    await publishConvUpdated({
      redis,
      type: "GROUP",
      roomId: "room-dup",
      recipientIds: ["a", "a", "b", "a", "b"],
      senderId: "a",
      lastMessageId: "m",
      lastMessageAt: 1,
      preview: basePreview,
    });

    assert.equal(publishCalls.length, 2);
    assert.deepEqual(publishCalls.map((c) => c.channel).sort(), [
      "user:a",
      "user:b",
    ]);
  });

  it("does nothing on empty recipients (no pipeline, no throw)", async () => {
    const fake = makeFakeRedis();
    const { redis, publishCalls } = fake;

    await assert.doesNotReject(
      publishConvUpdated({
        redis,
        type: "GROUP",
        roomId: "room-empty",
        recipientIds: [],
        senderId: "a",
        lastMessageId: "m",
        lastMessageAt: 1,
        preview: basePreview,
      })
    );

    assert.equal(fake.pipelineCount, 0, "pipeline never created");
    assert.equal(publishCalls.length, 0);
  });

  it("swallows pipeline.exec() failures and logs a warning", async () => {
    const { redis } = makeFakeRedis({ failExec: true });
    const warn = spyOnLoggerWarn();

    try {
      await assert.doesNotReject(
        publishConvUpdated({
          redis,
          type: "GROUP",
          roomId: "room-fail",
          recipientIds: ["a", "b"],
          senderId: "a",
          lastMessageId: "m",
          lastMessageAt: 1,
          preview: basePreview,
        })
      );

      assert.equal(warn.calls.length, 1, "exactly one warning logged");
      assert.match(String(warn.calls[0][0]), /conv:updated/);
      assert.match(String(warn.calls[0][0]), /room-fail/);
    } finally {
      warn.restore();
    }
  });
});

describe("publishCommunityUpdated", () => {
  const basePreview = { contentType: "text", text: "yo" };

  it("publishes one message per member with community:updated payload", async () => {
    const { redis, publishCalls } = makeFakeRedis();

    await publishCommunityUpdated({
      redis,
      communityId: "comm-1",
      // The chat room id is distinct from the community id (matches community:message:new).
      roomId: "room-1",
      memberIds: ["sender", "m2", "m3"],
      senderId: "sender",
      senderName: "Alice",
      lastMessageId: "cm-1",
      lastMessageAt: 1717000000999,
      preview: basePreview,
    });

    assert.equal(publishCalls.length, 3);
    assert.deepEqual(
      publishCalls.map((c) => c.channel),
      ["user:sender", "user:m2", "user:m3"]
    );

    const senderMsg = JSON.parse(
      publishCalls.find((c) => c.channel === "user:sender")!.payload
    );
    const memberMsg = JSON.parse(
      publishCalls.find((c) => c.channel === "user:m2")!.payload
    );

    assert.equal(senderMsg.event, "community:updated");
    assert.equal(senderMsg.data.communityId, "comm-1");
    // roomId carries the genuine chat room id, NOT a duplicate of communityId.
    assert.equal(senderMsg.data.roomId, "room-1");
    assert.notEqual(senderMsg.data.roomId, senderMsg.data.communityId);
    assert.equal(senderMsg.data.lastMessageId, "cm-1");
    assert.equal(typeof senderMsg.data.lastMessageAt, "number");
    assert.equal(senderMsg.data.senderName, "Alice");
    assert.equal(senderMsg.data.unread, false);
    assert.equal(memberMsg.data.unread, true);
  });

  it("de-dupes duplicate member ids", async () => {
    const { redis, publishCalls } = makeFakeRedis();

    await publishCommunityUpdated({
      redis,
      communityId: "comm-dup",
      roomId: "room-dup",
      memberIds: ["x", "x", "y"],
      senderId: "x",
      senderName: "",
      lastMessageId: "m",
      lastMessageAt: 1,
      preview: basePreview,
    });

    assert.equal(publishCalls.length, 2);
    assert.deepEqual(publishCalls.map((c) => c.channel).sort(), [
      "user:x",
      "user:y",
    ]);
  });

  it("does nothing on empty members (no pipeline, no throw)", async () => {
    const fake = makeFakeRedis();
    const { redis, publishCalls } = fake;

    await assert.doesNotReject(
      publishCommunityUpdated({
        redis,
        communityId: "comm-empty",
        roomId: "room-empty",
        memberIds: [],
        senderId: "x",
        senderName: "",
        lastMessageId: "m",
        lastMessageAt: 1,
        preview: basePreview,
      })
    );

    assert.equal(fake.pipelineCount, 0);
    assert.equal(publishCalls.length, 0);
  });

  it("swallows pipeline.exec() failures and logs a warning", async () => {
    const { redis } = makeFakeRedis({ failExec: true });
    const warn = spyOnLoggerWarn();

    try {
      await assert.doesNotReject(
        publishCommunityUpdated({
          redis,
          communityId: "comm-fail",
          roomId: "room-fail",
          memberIds: ["x", "y"],
          senderId: "x",
          senderName: "",
          lastMessageId: "m",
          lastMessageAt: 1,
          preview: basePreview,
        })
      );

      assert.equal(warn.calls.length, 1);
      assert.match(String(warn.calls[0][0]), /community:updated/);
      assert.match(String(warn.calls[0][0]), /comm-fail/);
    } finally {
      warn.restore();
    }
  });
});
