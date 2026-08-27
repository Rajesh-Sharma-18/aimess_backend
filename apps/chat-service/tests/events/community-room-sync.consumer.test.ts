/**
 * CommunityRoomSyncConsumer — membership-lifecycle join-line cleanup.
 *
 * When `community.member.synced` reports a membership going INACTIVE (LEFT /
 * BANNED), the consumer hard-deletes the user's PERSONAL join-session onboarding
 * lines ("You joined the community" / "{admin} added you to the community") so
 * they never accumulate across join→leave→rejoin cycles (Telegram parity). The
 * delete is bounded by the event's `eventAt` so a redelivered stale "left" can't
 * purge a fresher rejoin line. ACTIVE syncs must NOT purge.
 *
 * The repositories + redis + prisma are mocked so no broker/DB is needed; the
 * consumer is driven by a fake amqplib connection that captures the consume
 * callback (mirrors tests/events/user-profile.consumer.test.ts).
 */

const deletePersonalJoinMessages = jest.fn(async () => [] as string[]);
const upsert = jest.fn(async () => undefined);
const setMute = jest.fn(async () => undefined);

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

const notifyUnreadChanged = jest.fn();
jest.mock("../../src/events/unread-summary-bridge.js", () => ({
  notifyUnreadChanged,
}));

// Object key → presigned download URL. Stubbed so the test asserts WHERE the
// signing happens (wire only, never the persisted row) without needing MinIO.
const resolveMediaUrl = jest.fn(async (key?: string | null) =>
  key ? `https://signed.test/${key}?sig=1` : ""
);
jest.mock("../../src/lib/media-resolve.js", () => ({ resolveMediaUrl }));

jest.mock("../../src/config/prisma.js", () => ({ prisma: {} }));
jest.mock("../../src/config/redis.js", () => ({
  redis: {
    publish: jest.fn(async () => 1),
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
    setMute = setMute;
    markAllLeft = jest.fn(async () => undefined);
    findActiveByRoom = jest.fn(async () => []);
  },
}));
const setCommunityMeta = jest.fn(async () => undefined);
jest.mock("../../src/repositories/general-room.repository.js", () => ({
  GeneralRoomRepository: class {
    provisionForCommunity = jest.fn(async () => undefined);
    setCommunityMeta = setCommunityMeta;
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

import { PERSONAL_JOIN_SESSION_TYPES } from "@aimess/constants";

import { CommunityRoomSyncConsumer } from "../../src/events/community-room-sync.consumer.js";
import { redis } from "../../src/config/redis.js";

const redisPublish = redis.publish as unknown as jest.Mock;

/** The `types` array of every purge call made so far, in call order. */
const purgedTypes = () =>
  deletePersonalJoinMessages.mock.calls.map(
    (c) => (c[0] as unknown as { types: readonly string[] }).types
  );

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
    deletePersonalJoinMessages.mockResolvedValue([]);
    upsert.mockClear();
    redisPublish.mockClear();
    notifyUnreadChanged.mockClear();
  });

  // The Community nav badge is summed from ACTIVE membership rows only
  // (RoomMemberRepository.findActiveByUser), so any status flip silently changes
  // the total: a ban/leave subtracts that room's unread, a rejoin adds it back.
  // Nothing else recomputes it, so without this the badge kept its pre-ban value
  // until the user's next mark-read or reconnect.
  it.each(["BANNED", "LEFT", "ACTIVE"])(
    "%s sync recomputes the user's unread summary",
    async (status) => {
      const fake = await start();
      await fake.deliver(
        memberSynced({
          communityId: COMMUNITY,
          userId: USER,
          status,
          eventAt: EVENT_AT,
        })
      );
      expect(notifyUnreadChanged).toHaveBeenCalledWith(USER);
    }
  );

  it("role-only sync does NOT recompute the badge (membership is unchanged)", async () => {
    const fake = await start();
    await fake.deliver(
      memberSynced({ communityId: COMMUNITY, userId: USER, role: "MODERATOR" })
    );
    expect(notifyUnreadChanged).not.toHaveBeenCalled();
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
      types: PERSONAL_JOIN_SESSION_TYPES,
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
    expect(purgedTypes()).toContainEqual(PERSONAL_JOIN_SESSION_TYPES);
  });

  // A mute is scoped to the membership cycle that earned it. Leaving/being
  // removed ends that cycle, so the "You are muted until …" / "You were unmuted"
  // PERSONAL lines must go with it — otherwise they resurface in the timeline
  // after a later rejoin (the member reads as freshly joined yet sees an old
  // mute notice above it).
  it.each(["LEFT", "BANNED"])(
    "%s purges the cycle's mute/unmute lines, bounded by eventAt",
    async (status) => {
      const fake = await start();
      await fake.deliver(
        memberSynced({
          communityId: COMMUNITY,
          userId: USER,
          status,
          eventAt: EVENT_AT,
        })
      );
      expect(deletePersonalJoinMessages).toHaveBeenCalledWith({
        roomId: COMMUNITY,
        userId: USER,
        types: ["MEMBER_MUTED", "MEMBER_UNMUTED"],
        beforeOrAt: new Date(EVENT_AT),
      });
    }
  );

  it("REGRESSION: LEFT that purges a stale join line publishes community:message:deleted on the user's OWN channel, so an already-open client removes it without a reload", async () => {
    deletePersonalJoinMessages.mockResolvedValue(["stale-msg-1"]);
    const fake = await start();
    await fake.deliver(
      memberSynced({
        communityId: COMMUNITY,
        userId: USER,
        status: "LEFT",
        eventAt: EVENT_AT,
      })
    );

    const deleteCall = redisPublish.mock.calls.find(
      (c) =>
        (JSON.parse(c[1] as string) as { event: string }).event ===
        "community:message:deleted"
    );
    expect(deleteCall).toBeDefined();
    // Personal join line — must publish to the user's own channel, never the
    // community-wide room (other members never saw this line).
    expect(deleteCall![0]).toBe(`user:${USER}`);
    const parsed = JSON.parse(deleteCall![1] as string) as {
      data: Record<string, unknown>;
    };
    expect(parsed.data).toMatchObject({
      messageId: "stale-msg-1",
      communityId: COMMUNITY,
      roomId: COMMUNITY,
    });
  });

  it("does NOT publish community:message:deleted when nothing was purged", async () => {
    deletePersonalJoinMessages.mockResolvedValue([]);
    const fake = await start();
    await fake.deliver(
      memberSynced({
        communityId: COMMUNITY,
        userId: USER,
        status: "LEFT",
        eventAt: EVENT_AT,
      })
    );

    const deleteCall = redisPublish.mock.calls.find(
      (c) =>
        (JSON.parse(c[1] as string) as { event: string }).event ===
        "community:message:deleted"
    );
    expect(deleteCall).toBeUndefined();
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

  // The write-path gate reads the MIRRORED RoomMember.isMuted. Turning ACTIVE is
  // always a fresh membership cycle, so the mirror must be cleared in the SAME
  // write — if it only rode the separate `mute_synced` event, a dropped or
  // out-of-order stale `{isMuted:true}` would leave a rejoined member silently
  // unable to send, with no banner explaining why.
  it("REGRESSION: ACTIVE sync clears the mirrored mute so a rejoin can send immediately", async () => {
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
    expect(upsert).toHaveBeenCalledWith(
      COMMUNITY,
      USER,
      expect.objectContaining({
        status: "active",
        isMuted: false,
        mutedUntil: null,
      })
    );
  });

  // Muting an ALREADY-active member rides `mute_synced`, and a role change
  // publishes `role` with no `status` — so neither reaches the ACTIVE branch and
  // neither can wipe a legitimate live mute.
  it("role-only sync leaves the mirrored mute untouched (no status ⇒ no clear)", async () => {
    const fake = await start();
    await fake.deliver(
      memberSynced({ communityId: COMMUNITY, userId: USER, role: "MODERATOR" })
    );
    expect(upsert).toHaveBeenCalledWith(COMMUNITY, USER, { role: "moderator" });
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
      types: PERSONAL_JOIN_SESSION_TYPES,
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
      types: PERSONAL_JOIN_SESSION_TYPES,
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
      communityHandle: "developers",
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

  it("stores a COMMUNITY_INVITE message shaped like a call row + idempotency key", async () => {
    const fake = await start();
    await fake.deliver(inviteShared());

    expect(createMessage).toHaveBeenCalledTimes(1);
    const arg = createMessage.mock.calls[0][0];
    expect(arg).toMatchObject({
      roomId: ROOM.roomId,
      senderId: INVITER,
      receiverId: RECIPIENT,
      // Dedicated kind, not a generic SYSTEM row — same rule as VOICE_CALL.
      messageType: "COMMUNITY_INVITE",
      systemEvent: "COMMUNITY_INVITE",
      sequenceNumber: 7,
      // deterministic dedupe key
      // Per-share dedupe: key includes `eventAt` so N shares → N messages.
      clientMessageId: `cinv:${COMMUNITY}:${LINK_CODE}:${RECIPIENT}:${EVENT_AT}`,
    });
    // content.text is a non-blank human fallback (drives the inbox preview).
    expect(arg.content.text).toBe("Invitation to join Developers");
    expect(arg.content.urls).toEqual([]);
    expect(arg.content.files).toEqual([]);
    // The structured card the client renders — content.invitation is to an
    // invite row what content.call is to a call row.
    expect(arg.content.invitation).toEqual({
      type: "COMMUNITY_INVITATION",
      communityId: COMMUNITY,
      communityName: "Developers",
      communityHandle: "developers",
      communityAvatarUrl: "community/avatars/dev.jpg",
      memberCount: 256,
      inviteCode: LINK_CODE,
      deepLink: "aimess://join?code=abc123",
      alreadyJoined: false,
      // The live send path knows neither: the event carried no community type
      // (this fixture predates it) and bulk-send never reads join requests.
      // A historical read re-resolves both — see `enrichMessages`.
      communityType: null,
      joinRequestPending: false,
      status: "ACTIVE",
      canOpen: true,
    });
    // systemData keeps ONLY event-level metadata; nothing presentational is
    // duplicated out of content.invitation.
    expect(arg.systemData).toEqual({
      invitationType: "COMMUNITY",
      communityId: COMMUNITY,
      linkCode: LINK_CODE,
      inviteUrl: "https://aimess.me/+abc123",
      isPermanent: true,
      inviterId: INVITER,
      inviterName: "John",
      actorId: INVITER,
      actorName: "John",
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
      contentType: "COMMUNITY_INVITE",
      systemEvent: "COMMUNITY_INVITE",
      // The card must carry the handle so FE routes Join Now →
      // /community/@handle instead of the invite landing.
      content: {
        invitation: {
          type: "COMMUNITY_INVITATION",
          communityHandle: "developers",
        },
      },
      // Legacy mirror for pre-existing mobile clients — same object.
      systemAction: {
        type: "COMMUNITY_INVITATION",
        communityHandle: "developers",
      },
    });
  });

  it("REGRESSION: the wire card carries a SIGNED avatar URL while the stored row keeps the raw object key", async () => {
    const fake = await start();
    await fake.deliver(inviteShared());

    // Persisted: stable key (a presigned URL would expire in the DB).
    expect(
      createMessage.mock.calls[0][0].content.invitation.communityAvatarUrl
    ).toBe("community/avatars/dev.jpg");

    // Wire: signed — a client can't sign a key, and a bare key as an <img src>
    // is what made the invite card render the default AIMess avatar.
    const envelope = JSON.parse(
      redisPublish.mock.calls.find((c) => c[0] === `conv:${ROOM.roomId}`)![1]
    );
    const signed = "https://signed.test/community/avatars/dev.jpg?sig=1";
    expect(envelope.data.content.invitation.communityAvatarUrl).toBe(signed);
    expect(envelope.data.systemAction.communityAvatarUrl).toBe(signed);
    expect(
      publishConvUpdatedSafe.mock.calls[0][0].preview.systemAction
        .communityAvatarUrl
    ).toBe(signed);
  });

  it("bumps the inbox for BOTH participants and pushes the recipient (offline FCM/APNs)", async () => {
    const fake = await start();
    await fake.deliver(inviteShared());

    expect(publishConvUpdatedSafe).toHaveBeenCalledTimes(1);
    expect(publishConvUpdatedSafe.mock.calls[0][0]).toMatchObject({
      type: "PRIVATE",
      roomId: ROOM.roomId,
      recipientIds: [INVITER, RECIPIENT],
      preview: {
        contentType: "COMMUNITY_INVITE",
        text: "Invitation to join Developers",
      },
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

  it("two distinct SHARES of the same community produce two distinct messages (per-share eventAt breaks the dedupe key)", async () => {
    const fake = await start();
    await fake.deliver(inviteShared({ eventAt: "2026-06-20T10:05:00.000Z" }));
    await fake.deliver(inviteShared({ eventAt: "2026-06-20T10:06:00.000Z" }));

    expect(createMessage).toHaveBeenCalledTimes(2);
    const key1 = createMessage.mock.calls[0][0].clientMessageId;
    const key2 = createMessage.mock.calls[1][0].clientMessageId;
    expect(key1).not.toBe(key2);
    // Both must reference the same community + link + recipient — only the
    // per-share nonce differs. Guards the fix from regressing into
    // communityId-based or linkCode-based dedupe.
    expect(key1).toContain(`cinv:${COMMUNITY}:${LINK_CODE}:${RECIPIENT}:`);
    expect(key2).toContain(`cinv:${COMMUNITY}:${LINK_CODE}:${RECIPIENT}:`);
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

// ─────────────────────────────────────────────────────────────────────────────
// community.member.mute_synced → mirror moderation mute onto RoomMember so the
// chat write-path gate can block a muted member locally (no per-message gRPC).
// ─────────────────────────────────────────────────────────────────────────────

const muteSynced = (data: Record<string, unknown>) =>
  JSON.stringify({ type: "community.member.mute_synced", data });

describe("CommunityRoomSyncConsumer — moderation mute mirror", () => {
  beforeEach(() => {
    setMute.mockClear();
  });

  it("timed mute → setMute(isMuted=true, mutedUntil=Date) and acks", async () => {
    const until = "2026-06-21T00:00:00.000Z";
    const fake = await start();
    await fake.deliver(
      muteSynced({
        communityId: COMMUNITY,
        userId: USER,
        isMuted: true,
        mutedUntil: until,
      })
    );

    expect(setMute).toHaveBeenCalledWith(COMMUNITY, USER, {
      isMuted: true,
      mutedUntil: new Date(until),
    });
    expect(fake.channel.ack).toHaveBeenCalledTimes(1);
  });

  it("indefinite mute (no mutedUntil) → setMute(isMuted=true, mutedUntil=null)", async () => {
    const fake = await start();
    await fake.deliver(
      muteSynced({
        communityId: COMMUNITY,
        userId: USER,
        isMuted: true,
        mutedUntil: null,
      })
    );
    expect(setMute).toHaveBeenCalledWith(COMMUNITY, USER, {
      isMuted: true,
      mutedUntil: null,
    });
  });

  it("unmute → setMute(isMuted=false, mutedUntil=null)", async () => {
    const fake = await start();
    await fake.deliver(
      muteSynced({
        communityId: COMMUNITY,
        userId: USER,
        isMuted: false,
        mutedUntil: null,
      })
    );
    expect(setMute).toHaveBeenCalledWith(COMMUNITY, USER, {
      isMuted: false,
      mutedUntil: null,
    });
  });

  it("ignores an event with no userId (no setMute, still acks)", async () => {
    const fake = await start();
    await fake.deliver(muteSynced({ communityId: COMMUNITY, isMuted: true }));
    expect(setMute).not.toHaveBeenCalled();
    expect(fake.channel.ack).toHaveBeenCalledTimes(1);
  });
});

/**
 * `community.meta_synced` — the fix for stale community names in push.
 *
 * GeneralRoom.name is the ONLY community name chat-service holds, and every
 * community push title is built from it (getRoomName → chat.message_sent →
 * FCM/APNs). It used to be written once at `community.created` and never again,
 * so a rename left every future push carrying the old name. This event keeps
 * the mirror following the community row.
 */
describe("CommunityRoomSyncConsumer — community.meta_synced", () => {
  const metaSynced = (data: Record<string, unknown>) =>
    JSON.stringify({ type: "community.meta_synced", data });

  beforeEach(() => {
    setCommunityMeta.mockClear();
  });

  it("rename → mirrors the new name onto the room", async () => {
    const fake = await start();
    await fake.deliver(
      metaSynced({ communityId: COMMUNITY, name: "New Community Name" })
    );
    expect(setCommunityMeta).toHaveBeenCalledWith(COMMUNITY, {
      name: "New Community Name",
    });
    expect(fake.channel.ack).toHaveBeenCalledTimes(1);
  });

  it("avatar-only change → writes the logo, leaves the name untouched", async () => {
    const fake = await start();
    await fake.deliver(
      metaSynced({ communityId: COMMUNITY, avatarUrl: "community/a/new.png" })
    );
    expect(setCommunityMeta).toHaveBeenCalledWith(COMMUNITY, {
      logo: "community/a/new.png",
    });
  });

  it("avatar cleared (null) → writes null rather than skipping the field", async () => {
    const fake = await start();
    await fake.deliver(metaSynced({ communityId: COMMUNITY, avatarUrl: null }));
    expect(setCommunityMeta).toHaveBeenCalledWith(COMMUNITY, { logo: null });
  });
});
