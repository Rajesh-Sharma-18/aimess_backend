/**
 * Membership activation system-message + socket-event contract tests.
 *
 * Verifies:
 *   1. COMMUNITY_JOINED personal system message is emitted (existing).
 *   2. community:added socket event includes a canonical `lastActivity` that
 *      matches the `GET /communities/mine` contract for the joining user.
 *   3. Multi-device: publishChatUserEvent is called exactly once per
 *      activation — the gateway fan-out to all of a user's sockets is
 *      handled by the Redis adapter, not the service layer.
 *   4. Isolation: the joining user's private lastActivity is NOT broadcast
 *      to the community room (publishCommunityRoomEvent must not carry it).
 *
 * All I/O boundaries (Prisma, Redis, RabbitMQ, gRPC) are mocked in
 * global-mocks.ts. The real service logic executes unchanged.
 */

import { communityService } from "../src/services/community.service.js";
import { publishCommunitySystemMessageForChatSafe } from "../src/messaging/publish-community-chat.js";
import { publishCommunityMemberAddedSafe } from "../src/messaging/publish-community.js";
import { publishChatUserEvent, publishCommunityRoomEvent } from "@aimess/redis";

// TypeScript types only — no runtime import needed.
type MockFn = jest.MockedFunction<(...args: unknown[]) => unknown>;

const publishSystemMessage = publishCommunitySystemMessageForChatSafe as MockFn;
const publishMemberAdded = publishCommunityMemberAddedSafe as MockFn;
const publishUserEvent = publishChatUserEvent as jest.MockedFunction<
  typeof publishChatUserEvent
>;
const publishRoomEvent = publishCommunityRoomEvent as jest.MockedFunction<
  typeof publishCommunityRoomEvent
>;

// Minimal community fixture (only the fields notifyMemberJoined touches).
const community = {
  id: "comm-1",
  name: "Test Community",
  handle: "test-community",
  description: null,
  avatarUrl: null,
  coverUrl: null,
  type: "PUBLIC",
  status: "ACTIVE",
  moderationStatus: "ACTIVE",
  deletedAt: null,
  category: { id: "cat-1", name: "General" },
} as unknown as Parameters<
  typeof communityService.notifyMemberJoined
>[0]["community"];

// Minimal member fixture.
const member = {
  userId: "user-abc",
  role: "MEMBER",
  joinedAt: new Date("2026-06-25T10:00:00.000Z"),
  snapshotUsername: "testuser",
  snapshotDisplayName: "Test User",
  snapshotAvatarKey: null,
};

const EVENT_AT = "2026-06-25T10:00:00.000Z";

const BASE_ARGS = {
  community,
  member,
  memberCount: 5,
  actorId: "actor-xyz",
  via: "self_join" as const,
  eventAt: EVENT_AT,
};

// ---------------------------------------------------------------------------
// Existing: COMMUNITY_JOINED system message
// ---------------------------------------------------------------------------

describe("notifyMemberJoined — COMMUNITY_JOINED system message", () => {
  it("publishes a COMMUNITY_JOINED system message with visibleToUserId set to the joining user", async () => {
    await communityService.notifyMemberJoined(BASE_ARGS);

    expect(publishSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: community.id,
        systemMessageType: "COMMUNITY_JOINED",
        visibleToUserId: member.userId,
        triggeredByUserId: member.userId,
        eventAt: BASE_ARGS.eventAt,
      })
    );
  });

  it("publishes exactly one COMMUNITY_JOINED message per call", async () => {
    await communityService.notifyMemberJoined(BASE_ARGS);

    const joined = (
      publishSystemMessage as jest.MockedFunction<
        typeof publishCommunitySystemMessageForChatSafe
      >
    ).mock.calls.filter(
      (call) => call[0]?.systemMessageType === "COMMUNITY_JOINED"
    );
    expect(joined).toHaveLength(1);
  });

  it("uses the eventAt from args (stable across retries)", async () => {
    const stableTs = "2026-06-25T12:34:56.789Z";
    await communityService.notifyMemberJoined({
      ...BASE_ARGS,
      eventAt: stableTs,
    });

    expect(publishSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ eventAt: stableTs })
    );
  });
});

// ---------------------------------------------------------------------------
// skipCrossServiceNotification flag
// ---------------------------------------------------------------------------

describe("notifyMemberJoined — skipCrossServiceNotification flag", () => {
  it("calls publishCommunityMemberAddedSafe by default (skipCrossServiceNotification unset)", async () => {
    await communityService.notifyMemberJoined(BASE_ARGS);

    expect(publishMemberAdded).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: community.id,
        targetUserId: member.userId,
      })
    );
  });

  it("skips publishCommunityMemberAddedSafe when skipCrossServiceNotification is true", async () => {
    await communityService.notifyMemberJoined({
      ...BASE_ARGS,
      skipCrossServiceNotification: true,
    });

    expect(publishMemberAdded).not.toHaveBeenCalled();
  });

  it("still emits COMMUNITY_JOINED even when skipCrossServiceNotification is true", async () => {
    await communityService.notifyMemberJoined({
      ...BASE_ARGS,
      skipCrossServiceNotification: true,
    });

    expect(publishSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        systemMessageType: "COMMUNITY_JOINED",
        visibleToUserId: member.userId,
      })
    );
  });
});

// ---------------------------------------------------------------------------
// visibleToUserId isolation (system message)
// ---------------------------------------------------------------------------

describe("notifyMemberJoined — visibleToUserId isolation", () => {
  it("sets visibleToUserId to member.userId, not actorId", async () => {
    await communityService.notifyMemberJoined({
      ...BASE_ARGS,
      actorId: "admin-user-id",
      member: { ...member, userId: "joining-user-id" },
    });

    expect(publishSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        visibleToUserId: "joining-user-id",
        triggeredByUserId: "joining-user-id",
      })
    );
    expect(publishSystemMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ visibleToUserId: "admin-user-id" })
    );
  });
});

// ---------------------------------------------------------------------------
// Test 1 — community:added lastActivity contract
// ---------------------------------------------------------------------------

describe("notifyMemberJoined — community:added lastActivity (Test 1: Admin adds member)", () => {
  it("emits community:added to the joining user's personal channel", async () => {
    await communityService.notifyMemberJoined({
      ...BASE_ARGS,
      via: "add_members",
    });

    expect(publishUserEvent).toHaveBeenCalledWith(
      expect.anything(), // redis
      member.userId,
      "community:added",
      expect.anything()
    );
  });

  it("community:added payload includes lastActivity with preview 'You joined the community'", async () => {
    await communityService.notifyMemberJoined({
      ...BASE_ARGS,
      via: "add_members",
    });

    const call = publishUserEvent.mock.calls.find(
      ([, , event]) => event === "community:added"
    );
    expect(call).toBeDefined();
    const payload = call![3] as Record<string, unknown>;
    expect(payload.lastActivity).toMatchObject({
      type: "system",
      userId: null,
      username: null,
      preview: "You joined the community",
    });
  });

  it("lastActivity.dateTime equals Date.parse(eventAt) — matches Mine API dateTime", async () => {
    const eventAt = "2026-06-25T10:00:00.000Z";
    await communityService.notifyMemberJoined({
      ...BASE_ARGS,
      via: "add_members",
      eventAt,
    });

    const call = publishUserEvent.mock.calls.find(
      ([, , event]) => event === "community:added"
    );
    const payload = call![3] as Record<string, unknown>;
    const lastActivity = payload.lastActivity as Record<string, unknown>;
    expect(lastActivity.dateTime).toBe(Date.parse(eventAt));
  });

  it("community:added lastActivity.type is 'system' (senderless — no username prefix)", async () => {
    await communityService.notifyMemberJoined({
      ...BASE_ARGS,
      via: "add_members",
    });

    const call = publishUserEvent.mock.calls.find(
      ([, , event]) => event === "community:added"
    );
    const lastActivity = (call![3] as Record<string, unknown>)
      .lastActivity as Record<string, unknown>;
    expect(lastActivity.type).toBe("system");
    expect(lastActivity.userId).toBeNull();
    expect(lastActivity.username).toBeNull();
  });

  it("community:added lastActivity is present for all via values", async () => {
    const viaValues = [
      "add_members",
      "join_request_approved",
      "join_request_auto_accept",
      "invite_auto_approve",
      "invite_link_redeem",
      "self_join",
    ] as const;

    for (const via of viaValues) {
      publishUserEvent.mockClear();
      await communityService.notifyMemberJoined({ ...BASE_ARGS, via });
      const call = publishUserEvent.mock.calls.find(
        ([, , event]) => event === "community:added"
      );
      expect(call).toBeDefined();
      const lastActivity = (call![3] as Record<string, unknown>)
        .lastActivity as Record<string, unknown>;
      expect(lastActivity).toBeDefined();
      expect(lastActivity.preview).toBe("You joined the community");
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Multi-device: one Redis publish, gateway fans out
// ---------------------------------------------------------------------------

describe("notifyMemberJoined — multi-device (Test 2)", () => {
  it("publishChatUserEvent is called exactly once per membership activation (gateway handles per-device fan-out)", async () => {
    await communityService.notifyMemberJoined({
      ...BASE_ARGS,
      via: "add_members",
    });

    const communityAddedCalls = publishUserEvent.mock.calls.filter(
      ([, , event]) => event === "community:added"
    );
    // The service publishes once to Redis; the gateway re-emits to all of
    // User B's active sockets. One publish = all devices receive it.
    expect(communityAddedCalls).toHaveLength(1);
  });

  it("the single publish targets the joining user's personal channel (user:<userId>)", async () => {
    const joiningUserId = "device-test-user";
    await communityService.notifyMemberJoined({
      ...BASE_ARGS,
      via: "add_members",
      member: { ...member, userId: joiningUserId },
    });

    const call = publishUserEvent.mock.calls.find(
      ([, , event]) => event === "community:added"
    );
    expect(call![1]).toBe(joiningUserId);
  });

  it("both calls carry identical lastActivity (idempotent payloads for retry)", async () => {
    const eventAt = "2026-06-25T11:00:00.000Z";
    // Simulate a retry: call notifyMemberJoined twice with same eventAt.
    await communityService.notifyMemberJoined({
      ...BASE_ARGS,
      eventAt,
      via: "add_members",
    });
    await communityService.notifyMemberJoined({
      ...BASE_ARGS,
      eventAt,
      via: "add_members",
    });

    const calls = publishUserEvent.mock.calls.filter(
      ([, , event]) => event === "community:added"
    );
    expect(calls).toHaveLength(2);
    const la1 = (calls[0]![3] as Record<string, unknown>).lastActivity;
    const la2 = (calls[1]![3] as Record<string, unknown>).lastActivity;
    expect(la1).toEqual(la2);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Other members must not receive User B's private lastActivity
// ---------------------------------------------------------------------------

describe("notifyMemberJoined — other-member isolation (Test 3)", () => {
  it("does NOT broadcast community:added to the community room", async () => {
    await communityService.notifyMemberJoined({
      ...BASE_ARGS,
      via: "add_members",
    });

    const roomCalls = publishRoomEvent.mock.calls.filter(
      ([, , event]) => event === "community:added"
    );
    expect(roomCalls).toHaveLength(0);
  });

  it("community room events do not carry lastActivity (member:joined and stats:updated only)", async () => {
    await communityService.notifyMemberJoined({
      ...BASE_ARGS,
      via: "add_members",
    });

    for (const call of publishRoomEvent.mock.calls) {
      const payload = call[3] as Record<string, unknown>;
      // lastActivity must never appear in room-scoped events — it is personal
      expect(payload).not.toHaveProperty("lastActivity");
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Retry / idempotency
// ---------------------------------------------------------------------------

describe("notifyMemberJoined — retry idempotency (Test 4)", () => {
  it("stable eventAt produces stable lastActivity.dateTime across retries", async () => {
    const stableEventAt = "2026-06-25T09:30:00.000Z";
    const expected = Date.parse(stableEventAt);

    await communityService.notifyMemberJoined({
      ...BASE_ARGS,
      eventAt: stableEventAt,
      via: "add_members",
    });
    await communityService.notifyMemberJoined({
      ...BASE_ARGS,
      eventAt: stableEventAt,
      via: "add_members",
    });

    const calls = publishUserEvent.mock.calls.filter(
      ([, , event]) => event === "community:added"
    );
    for (const call of calls) {
      const la = (call[3] as Record<string, unknown>).lastActivity as Record<
        string,
        unknown
      >;
      expect(la.dateTime).toBe(expected);
    }
  });

  it("retry does not duplicate COMMUNITY_JOINED system messages (idempotency guard is eventAt-keyed)", async () => {
    // The service emits the RabbitMQ message; chat-service deduplicates by
    // sys:COMMUNITY_JOINED:{eventAt}:u:{userId}. The service itself does not
    // guard — verify the publish is called once per notifyMemberJoined call.
    const eventAt = "2026-06-25T09:00:00.000Z";
    await communityService.notifyMemberJoined({
      ...BASE_ARGS,
      eventAt,
      via: "add_members",
    });

    const joined = (
      publishSystemMessage as jest.MockedFunction<
        typeof publishCommunitySystemMessageForChatSafe
      >
    ).mock.calls.filter(
      (call) => call[0]?.systemMessageType === "COMMUNITY_JOINED"
    );
    expect(joined).toHaveLength(1);
  });
});
