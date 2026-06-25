/**
 * CommunityRoomSyncConsumer — membership-lifecycle join-line cleanup.
 *
 * When `community.member.synced` reports a membership going INACTIVE (LEFT /
 * BANNED), the consumer hard-deletes the user's PERSONAL join-session onboarding
 * lines ("You joined the community" / "Your request to join was approved") so
 * they never accumulate across join→leave→rejoin cycles (Telegram parity). The
 * delete is bounded by the event's `eventAt` so a redelivered stale "left" can't
 * purge a fresher rejoin line. ACTIVE syncs must NOT purge.
 *
 * The repositories + redis + prisma are mocked so no broker/DB is needed; the
 * consumer is driven by a fake amqplib connection that captures the consume
 * callback (mirrors tests/events/user-profile.consumer.test.ts).
 */

const deletePersonalJoinMessages = jest.fn(async () => 1);
const upsert = jest.fn(async () => undefined);

jest.mock("../../src/config/prisma.js", () => ({ prisma: {} }));
jest.mock("../../src/config/redis.js", () => ({
  redis: { publish: jest.fn(async () => 1), on: jest.fn() },
}));
jest.mock("../../src/repositories/general-room-message.repository.js", () => ({
  GeneralRoomMessageRepository: class {
    deletePersonalJoinMessages = deletePersonalJoinMessages;
  },
}));
jest.mock("../../src/repositories/room-member.repository.js", () => ({
  RoomMemberRepository: class {
    upsert = upsert;
    markAllLeft = jest.fn(async () => undefined);
    findActiveByRoom = jest.fn(async () => []);
  },
}));
jest.mock("../../src/repositories/general-room.repository.js", () => ({
  GeneralRoomRepository: class {
    provisionForCommunity = jest.fn(async () => undefined);
  },
}));
jest.mock("../../src/repositories/private-room.repository.js", () => ({
  PrivateRoomRepository: class {},
}));
jest.mock("../../src/repositories/private-message.repository.js", () => ({
  PrivateMessageRepository: class {},
}));
jest.mock("../../src/repositories/cache.repository.js", () => ({
  CacheRepository: class {},
}));
jest.mock("../../src/services/community-system-message.service.js", () => ({
  CommunitySystemMessageService: class {
    post = jest.fn(async () => undefined);
  },
}));
jest.mock("../../src/services/user-snapshot.service.js", () => ({
  UserSnapshotService: class {},
}));

import { CommunityRoomSyncConsumer } from "../../src/events/community-room-sync.consumer.js";

const COMMUNITY = "c".repeat(24);
const USER = "11111111-1111-4111-8111-111111111111";
const EVENT_AT = "2026-06-20T10:05:00.000Z";

function makeFakeConnection() {
  let onMessage: ((msg: unknown) => unknown) | null = null;
  const channel = {
    assertQueue: jest.fn(async () => undefined),
    consume: jest.fn(async (_q: string, cb: (msg: unknown) => unknown) => {
      onMessage = cb;
      return { consumerTag: "t" };
    }),
    close: jest.fn(async () => undefined),
    ack: jest.fn(),
    nack: jest.fn(),
  };
  return {
    connection: { createChannel: jest.fn(async () => channel) },
    channel,
    deliver: (body: unknown) =>
      onMessage?.({ content: Buffer.from(String(body)) }),
  };
}

const memberSynced = (data: Record<string, unknown>) =>
  JSON.stringify({ type: "community.member.synced", data });

async function start() {
  const fake = makeFakeConnection();
  const consumer = new CommunityRoomSyncConsumer();
  await consumer.start(fake.connection as never);
  return fake;
}

describe("CommunityRoomSyncConsumer — join-line cleanup", () => {
  beforeEach(() => {
    deletePersonalJoinMessages.mockClear();
    deletePersonalJoinMessages.mockResolvedValue(1);
    upsert.mockClear();
  });

  it("LEFT purges the user's join lines bounded by eventAt, and acks", async () => {
    const fake = await start();
    await fake.deliver(
      memberSynced({
        communityId: COMMUNITY,
        userId: USER,
        status: "LEFT",
        eventAt: EVENT_AT,
      })
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(deletePersonalJoinMessages).toHaveBeenCalledWith({
      roomId: COMMUNITY,
      userId: USER,
      beforeOrAt: new Date(EVENT_AT),
    });
    expect(fake.channel.ack).toHaveBeenCalledTimes(1);
    expect(fake.channel.nack).not.toHaveBeenCalled();
  });

  it("BANNED also purges the join lines", async () => {
    const fake = await start();
    await fake.deliver(
      memberSynced({
        communityId: COMMUNITY,
        userId: USER,
        status: "BANNED",
        eventAt: EVENT_AT,
      })
    );
    expect(deletePersonalJoinMessages).toHaveBeenCalledTimes(1);
  });

  it("ACTIVE sync does NOT purge (rejoin must keep its fresh line)", async () => {
    const fake = await start();
    await fake.deliver(
      memberSynced({
        communityId: COMMUNITY,
        userId: USER,
        status: "ACTIVE",
        role: "MEMBER",
        eventAt: EVENT_AT,
      })
    );
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(deletePersonalJoinMessages).not.toHaveBeenCalled();
    expect(fake.channel.ack).toHaveBeenCalledTimes(1);
  });

  it("PENDING does NOT purge (gated on raw status, not mapped 'left')", async () => {
    const fake = await start();
    await fake.deliver(
      memberSynced({
        communityId: COMMUNITY,
        userId: USER,
        status: "PENDING",
        eventAt: EVENT_AT,
      })
    );
    expect(deletePersonalJoinMessages).not.toHaveBeenCalled();
  });

  it("LEFT with no eventAt purges unbounded (beforeOrAt undefined)", async () => {
    const fake = await start();
    await fake.deliver(
      memberSynced({ communityId: COMMUNITY, userId: USER, status: "LEFT" })
    );
    expect(deletePersonalJoinMessages).toHaveBeenCalledWith({
      roomId: COMMUNITY,
      userId: USER,
      beforeOrAt: undefined,
    });
  });

  it("LEFT with a malformed eventAt falls back to unbounded (no NaN date)", async () => {
    const fake = await start();
    await fake.deliver(
      memberSynced({
        communityId: COMMUNITY,
        userId: USER,
        status: "LEFT",
        eventAt: "not-a-date",
      })
    );
    expect(deletePersonalJoinMessages).toHaveBeenCalledWith({
      roomId: COMMUNITY,
      userId: USER,
      beforeOrAt: undefined,
    });
  });

  it("acks even when the cleanup delete throws (fail-soft)", async () => {
    deletePersonalJoinMessages.mockRejectedValueOnce(new Error("db down"));
    const fake = await start();
    await fake.deliver(
      memberSynced({
        communityId: COMMUNITY,
        userId: USER,
        status: "LEFT",
        eventAt: EVENT_AT,
      })
    );
    expect(fake.channel.ack).toHaveBeenCalledTimes(1);
    expect(fake.channel.nack).not.toHaveBeenCalled();
  });
});
