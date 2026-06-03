import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Redis } from "ioredis";

import { GroupSystemMessageService } from "./group-system-message.service.js";
import { SystemEvent } from "../types/enums.js";
import type { GroupMessageRepository } from "../repositories/group-message.repository.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";

/**
 * Records every dependency interaction the system-message post() touches so a
 * test can assert the allocated per-room sequence flows into both the persisted
 * message and the real-time `message:new` payload (the bug: it used to default
 * to 0). Deps are cast through `unknown` — the service only calls the handful of
 * methods stubbed here.
 */
function makeService(opts: { allocatedSeq: number }) {
  const createCalls: Array<Record<string, unknown>> = [];
  const publishCalls: Array<{ channel: string; payload: string }> = [];
  let allocateSequenceCalls = 0;

  const messageRepo = {
    async create(data: Record<string, unknown>) {
      createCalls.push(data);
      return {
        id: "msg-sys-1",
        senderId: (data.senderId as string) ?? null,
        senderName: (data.senderName as string) ?? "",
        messageType: (data.messageType as string) ?? "SYSTEM",
        content: (data.content as object) ?? {},
        createdAt: new Date(1717000000000),
      };
    },
  };

  const roomRepo = {
    async allocateSequence(_roomId: string) {
      allocateSequenceCalls += 1;
      return opts.allocatedSeq;
    },
    async updateLastMessage(_roomId: string, _last: unknown) {
      return undefined;
    },
  };

  const cacheRepo = {} as unknown as CacheRepository;

  const userSnapshotService = {
    async getUserSnapshotsMap(ids: string[]) {
      const map = new Map<string, Record<string, unknown>>();
      for (const id of ids) {
        map.set(id, { displayName: `Name-${id}`, avatar: `avatar-${id}` });
      }
      return map;
    },
  };

  const redis = {
    publish(channel: string, payload: string) {
      publishCalls.push({ channel, payload });
      return Promise.resolve(1);
    },
  };

  const service = new GroupSystemMessageService(
    messageRepo as unknown as GroupMessageRepository,
    roomRepo as unknown as GroupRoomRepository,
    cacheRepo,
    userSnapshotService as unknown as UserSnapshotService,
    redis as unknown as Redis
  );

  return {
    service,
    createCalls,
    publishCalls,
    get allocateSequenceCalls() {
      return allocateSequenceCalls;
    },
  };
}

describe("GroupSystemMessageService.post", () => {
  it("allocates a sequence and persists it on the created message (not 0)", async () => {
    const h = makeService({ allocatedSeq: 7 });

    await h.service.post({
      roomId: "room-1",
      actorId: "actor-1",
      systemEvent: SystemEvent.MEMBER_JOINED,
    });

    assert.equal(h.allocateSequenceCalls, 1, "allocateSequence called once");
    assert.equal(h.createCalls.length, 1, "exactly one message created");
    assert.equal(
      h.createCalls[0].sequenceNumber,
      7,
      "created message carries the allocated sequenceNumber, not 0"
    );
  });

  it("includes the allocated sequenceNumber in the message:new payload", async () => {
    const h = makeService({ allocatedSeq: 7 });

    await h.service.post({
      roomId: "room-1",
      actorId: "actor-1",
      systemEvent: SystemEvent.MEMBER_LEFT,
    });

    assert.equal(h.publishCalls.length, 1, "one real-time fan-out");
    assert.equal(h.publishCalls[0].channel, "conv:room-1");

    const msg = JSON.parse(h.publishCalls[0].payload);
    assert.equal(msg.event, "message:new");
    assert.equal(
      msg.data.sequenceNumber,
      7,
      "fan-out payload carries the allocated sequenceNumber"
    );
    assert.equal(msg.data.contentType, "SYSTEM");
    assert.equal(msg.data.conversationId, "room-1");

    // The catchup contract (system_event / system_data) must also ride the
    // realtime fan-out so live + reconnect render identically.
    assert.equal(
      msg.data.systemEvent,
      SystemEvent.MEMBER_LEFT,
      "fan-out payload carries the systemEvent code"
    );
    assert.ok(msg.data.systemData, "fan-out payload carries systemData");
    assert.equal(
      msg.data.systemData.actorId,
      "actor-1",
      "systemData includes the resolved actorId"
    );
  });
});
