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

// Private-DM repo primitives used by deliverInviteLinkDm (invite-link sharing).
const findByParticipantsKey = jest.fn();
const createRoom = jest.fn();
const allocateSequence = jest.fn(async () => 1);
const updateRoomOnNewMessage = jest.fn(async () => null);
const findByClientMessageId = jest.fn(async () => null);
const createMessage = jest.fn();
const publishConvUpdatedSafe = jest.fn();
const publishMessageSentSafe = jest.fn();

jest.mock("../../src/events/publish-conv-updated.js", () => ({
  publishConvUpdatedSafe,
}));
jest.mock("../../src/events/publish-message-sent.js", () => ({
  publishMessageSentSafe,
}));

jest.mock("../../src/config/prisma.js", () => ({ prisma: {} }));
jest.mock("../../src/config/redis.js", () => ({
  redis: {
    publish: jest.fn(async () => 1),
    // The ACTIVE member.synced branch writes a `community:fresh-join:*` key.
    set: jest.fn(async () => "OK"),
    on: jest.fn(),
  },
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
  PrivateRoomRepository: class {
    findByParticipantsKey = findByParticipantsKey;
    create = createRoom;
    allocateSequence = allocateSequence;
    updateRoomOnNewMessage = updateRoomOnNewMessage;
  },
}));
jest.mock("../../src/repositories/private-message.repository.js", () => ({
  PrivateMessageRepository: class {
    findByClientMessageId = findByClientMessageId;
    createMessage = createMessage;
  },
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
import { redis } from "../../src/config/redis.js";

const redisPublish = redis.publish as unknown as jest.Mock;

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

// ─────────────────────────────────────────────────────────────────────────────
// community.invite_link_shared → 1-to-1 personal chat DM (Telegram-style).
// The invitation must behave EXACTLY like a normal private message: stored as a
// message, broadcast on conv:<roomId>, inbox-bumped, unread/last-activity
// updated, and pushed for offline devices — and be idempotent.
// ─────────────────────────────────────────────────────────────────────────────

const INVITER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RECIPIENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LINK_CODE = "abc123";
const ROOM = { roomId: "prv_room1", participants: [INVITER, RECIPIENT].sort() };

const inviteShared = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "community.invite_link_shared",
    data: {
      communityId: COMMUNITY,
      communityName: "Developers",
      linkCode: LINK_CODE,
      inviterId: INVITER,
      recipientId: RECIPIENT,
      eventAt: EVENT_AT,
      communityAvatarUrl: "community/avatars/dev.jpg",
      memberCount: 256,
      inviteUrl: "https://aimess.me/+abc123",
      inviteDeepLink: "aimess://join?code=abc123",
      isPermanent: true,
      inviterName: "John",
      inviterAvatarUrl: "avatars/john.jpg",
      ...over,
    },
  });

describe("CommunityRoomSyncConsumer — invite-link DM delivery", () => {
  beforeEach(() => {
    findByParticipantsKey.mockReset().mockResolvedValue(ROOM);
    createRoom.mockReset().mockResolvedValue(ROOM);
    allocateSequence.mockReset().mockResolvedValue(7);
    updateRoomOnNewMessage.mockReset().mockResolvedValue(null);
    findByClientMessageId.mockReset().mockResolvedValue(null);
    createMessage
      .mockReset()
      .mockResolvedValue({ id: "msg_1", createdAt: new Date(EVENT_AT) });
    publishConvUpdatedSafe.mockReset();
    publishMessageSentSafe.mockReset();
    redisPublish.mockClear();
  });

  it("stores a SYSTEM invitation message with the enriched card payload + idempotency key", async () => {
    const fake = await start();
    await fake.deliver(inviteShared());

    expect(createMessage).toHaveBeenCalledTimes(1);
    const arg = createMessage.mock.calls[0][0];
    expect(arg).toMatchObject({
      roomId: ROOM.roomId,
      senderId: INVITER,
      receiverId: RECIPIENT,
      messageType: "SYSTEM",
      systemEvent: "COMMUNITY_INVITE",
      sequenceNumber: 7,
      // deterministic dedupe key
      clientMessageId: `cinv:${COMMUNITY}:${LINK_CODE}:${RECIPIENT}`,
    });
    // content.text is a non-blank human fallback (drives the inbox preview).
    expect(arg.content.text).toBe("Invitation to join Developers");
    // structured card data the client renders.
    expect(arg.systemData).toMatchObject({
      communityId: COMMUNITY,
      communityName: "Developers",
      communityAvatarUrl: "community/avatars/dev.jpg",
      memberCount: 256,
      linkCode: LINK_CODE,
      inviteUrl: "https://aimess.me/+abc123",
      inviteDeepLink: "aimess://join?code=abc123",
      isPermanent: true,
      inviterId: INVITER,
      inviterName: "John",
    });
    expect(fake.channel.ack).toHaveBeenCalledTimes(1);
  });

  it("updates unread + last-activity and broadcasts message:new on conv:<roomId>", async () => {
    const fake = await start();
    await fake.deliver(inviteShared());

    // last-activity / unread bump on the room (fixes the blank inbox preview).
    expect(updateRoomOnNewMessage).toHaveBeenCalledTimes(1);
    expect(updateRoomOnNewMessage.mock.calls[0][0]).toMatchObject({
      roomId: ROOM.roomId,
      receiverId: RECIPIENT,
    });

    // canonical message:new socket broadcast on the conversation channel.
    const newMsgPublish = redisPublish.mock.calls.find(
      (c) => c[0] === `conv:${ROOM.roomId}`
    );
    expect(newMsgPublish).toBeDefined();
    const envelope = JSON.parse(newMsgPublish![1]);
    expect(envelope.event).toBe("message:new");
    expect(envelope.data).toMatchObject({
      id: "msg_1",
      conversationType: "PRIVATE",
      senderId: INVITER,
      receiverId: RECIPIENT,
      contentType: "SYSTEM",
      systemEvent: "COMMUNITY_INVITE",
    });
  });

  it("bumps the inbox for BOTH participants and pushes the recipient (offline FCM/APNs)", async () => {
    const fake = await start();
    await fake.deliver(inviteShared());

    expect(publishConvUpdatedSafe).toHaveBeenCalledTimes(1);
    expect(publishConvUpdatedSafe.mock.calls[0][0]).toMatchObject({
      type: "PRIVATE",
      roomId: ROOM.roomId,
      recipientIds: [INVITER, RECIPIENT],
      preview: { contentType: "SYSTEM", text: "Invitation to join Developers" },
    });

    expect(publishMessageSentSafe).toHaveBeenCalledTimes(1);
    expect(publishMessageSentSafe.mock.calls[0][0]).toMatchObject({
      conversationId: ROOM.roomId,
      conversationType: "PRIVATE",
      recipientIds: [RECIPIENT],
      senderName: "John",
      preview: "Invitation to join Developers",
      communityId: COMMUNITY,
      communityName: "Developers",
    });
    expect(fake.channel.ack).toHaveBeenCalledTimes(1);
  });

  it("reuses an existing private conversation (no room created)", async () => {
    findByParticipantsKey.mockResolvedValue(ROOM);
    const fake = await start();
    await fake.deliver(inviteShared());

    expect(createRoom).not.toHaveBeenCalled();
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it("creates the private conversation when none exists", async () => {
    findByParticipantsKey.mockResolvedValue(null);
    const fake = await start();
    await fake.deliver(inviteShared());

    expect(createRoom).toHaveBeenCalledTimes(1);
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — a duplicate event is suppressed (no second message, no broadcast)", async () => {
    findByClientMessageId.mockResolvedValue({ id: "msg_1" }); // already delivered
    const fake = await start();
    await fake.deliver(inviteShared());

    expect(createMessage).not.toHaveBeenCalled();
    expect(updateRoomOnNewMessage).not.toHaveBeenCalled();
    expect(publishConvUpdatedSafe).not.toHaveBeenCalled();
    expect(publishMessageSentSafe).not.toHaveBeenCalled();
    expect(
      redisPublish.mock.calls.find((c) => c[0] === `conv:${ROOM.roomId}`)
    ).toBeUndefined();
    expect(fake.channel.ack).toHaveBeenCalledTimes(1);
  });

  it("swallows a unique-index create race (E11000) without broadcasting", async () => {
    findByClientMessageId.mockResolvedValue(null);
    createMessage.mockRejectedValue(
      Object.assign(new Error("E11000 duplicate key"), { code: "P2002" })
    );
    const fake = await start();
    await fake.deliver(inviteShared());

    expect(publishConvUpdatedSafe).not.toHaveBeenCalled();
    expect(publishMessageSentSafe).not.toHaveBeenCalled();
    // the create race is swallowed → consumer still acks (no requeue storm).
    expect(fake.channel.ack).toHaveBeenCalledTimes(1);
    expect(fake.channel.nack).not.toHaveBeenCalled();
  });
});
