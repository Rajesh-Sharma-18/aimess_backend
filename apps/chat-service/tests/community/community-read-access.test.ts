/**
 * Telegram-style community history access + personal system-message visibility.
 *
 * Covers two requirements:
 *  1. PUBLIC communities let non-members read message history; PRIVATE communities
 *     block non-members (and banned users in either case) with CHAT_NOT_A_MEMBER.
 *  2. The "You joined the community" SYSTEM message is PERSONAL: persisted with a
 *     `visibleToUserId`, published to `user:<id>` (not the community room), and never
 *     surfaced to other members.
 */
import { ForbiddenError } from "@aimess/errors";

import { assertCommunityReadAccess } from "../../src/lib/access-guard.js";
import { CommunityMessageService } from "../../src/services/community-message.service.js";
import { CommunitySystemMessageService } from "../../src/services/community-system-message.service.js";
import { CommunityPinService } from "../../src/services/community-pin.service.js";
import { GeneralRoomMessageRepository } from "../../src/repositories/general-room-message.repository.js";

const ROOM_ID = "c".repeat(24);
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

// ---------------------------------------------------------------------------
// Repository in-memory PERSONAL-visibility filter — the regression that caused
// non-members to see an empty page (data:[] while totalData>0). Prisma's
// `{ visibleToUserId: null }` does NOT match field-absent Mongo docs, so the
// filter runs in memory: field-absent + null + own-target are kept, another
// user's personal message is dropped.
// ---------------------------------------------------------------------------
describe("GeneralRoomMessageRepository personal-visibility filter", () => {
  it("findByRoomIdTimeline keeps field-absent/own messages, drops others' personal", async () => {
    const rows = [
      { id: "1", deletedBy: [] }, // legacy doc: no visibleToUserId field at all
      { id: "2", deletedBy: [], visibleToUserId: null }, // explicit null
      { id: "3", deletedBy: [], visibleToUserId: USER_ID }, // mine
      { id: "4", deletedBy: [], visibleToUserId: OTHER_ID }, // someone else's
    ];
    const prisma = {
      generalRoomMessage: { findMany: jest.fn().mockResolvedValue(rows) },
    };
    const repo = new GeneralRoomMessageRepository(prisma as never);

    const result = await repo.findByRoomIdTimeline({
      roomId: ROOM_ID,
      userId: USER_ID,
      direction: "before",
      ts: new Date(),
      limit: 30,
    });

    expect(result.map((m) => m.id)).toEqual(["1", "2", "3"]);
    // The where-clause must NOT carry an `OR` on visibleToUserId (it would drop
    // legacy field-absent docs in real Mongo) — visibility is filtered in memory.
    const where = prisma.generalRoomMessage.findMany.mock.calls[0][0].where;
    expect(where.OR).toBeUndefined();
  });

  it("findLatestPersonalByRooms scopes the $match to the caller and decodes extended-JSON", async () => {
    const aggregateRaw = jest.fn().mockResolvedValue([
      {
        _id: { $oid: ROOM_ID },
        message: "You joined the community",
        createdAt: { $date: "2026-06-20T10:05:00.000Z" },
      },
    ]);
    const prisma = { generalRoomMessage: { aggregateRaw } };
    const repo = new GeneralRoomMessageRepository(prisma as never);

    const map = await repo.findLatestPersonalByRooms({
      userId: USER_ID,
      roomIds: [ROOM_ID],
    });

    // Keyed by room hex, with a real Date decoded from `{ $date }`.
    const entry = map.get(ROOM_ID);
    expect(entry?.message).toBe("You joined the community");
    expect(entry?.createdAt.toISOString()).toBe("2026-06-20T10:05:00.000Z");

    // The aggregation must restrict to the CALLER's own personal rows — never
    // another user's (the whole point of PERSONAL visibility).
    const pipeline = aggregateRaw.mock.calls[0][0].pipeline;
    const match = pipeline.find(
      (s: Record<string, unknown>) => "$match" in s
    ).$match;
    expect(match.visibleToUserId).toBe(USER_ID);
    expect(match.roomId).toEqual({ $in: [{ $oid: ROOM_ID }] });
    expect(match.deletedForAll).toBe(false);
  });

  it("findLatestPersonalByRooms short-circuits with no rooms (no query)", async () => {
    const aggregateRaw = jest.fn();
    const prisma = { generalRoomMessage: { aggregateRaw } };
    const repo = new GeneralRoomMessageRepository(prisma as never);

    const map = await repo.findLatestPersonalByRooms({
      userId: USER_ID,
      roomIds: [],
    });

    expect(map.size).toBe(0);
    expect(aggregateRaw).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Membership-lifecycle join-line cleanup (Telegram parity): on leave/remove/
  // ban the user's PERSONAL join-session onboarding lines are hard-deleted so
  // they never accumulate across rejoin cycles.
  // -------------------------------------------------------------------------
  it("deletePersonalJoinMessages purges only the user's join-session lines, bounded by eventAt", async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = { generalRoomMessage: { deleteMany } };
    const repo = new GeneralRoomMessageRepository(prisma as never);

    const boundary = new Date(1_700_000_500_000);
    const count = await repo.deletePersonalJoinMessages({
      roomId: ROOM_ID,
      userId: USER_ID,
      beforeOrAt: boundary,
    });

    expect(count).toBe(1);
    const where = deleteMany.mock.calls[0][0].where;
    expect(where.roomId).toBe(ROOM_ID);
    // Scoped to the user's OWN personal rows only.
    expect(where.visibleToUserId).toBe(USER_ID);
    // Only the two join-session onboarding subtypes.
    expect(where.systemMessageType).toEqual({
      in: ["COMMUNITY_JOINED", "JOIN_REQUEST_APPROVED"],
    });
    // Bounded by the leave time so a redelivered stale "left" can't nuke a
    // fresher rejoin line.
    expect(where.createdAt).toEqual({ lte: boundary });
  });

  it("deletePersonalJoinMessages omits the createdAt bound when no eventAt given", async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = { generalRoomMessage: { deleteMany } };
    const repo = new GeneralRoomMessageRepository(prisma as never);

    await repo.deletePersonalJoinMessages({ roomId: ROOM_ID, userId: USER_ID });

    const where = deleteMany.mock.calls[0][0].where;
    expect(where.createdAt).toBeUndefined();
  });

  it("read guard hides a non-active member's OWN join line but keeps it for an active member", async () => {
    const rows = [
      {
        id: "join",
        deletedBy: [],
        visibleToUserId: USER_ID,
        systemMessageType: "COMMUNITY_JOINED",
      },
      { id: "msg", deletedBy: [], visibleToUserId: null }, // community-wide
    ];
    const makeRepo = () => {
      const prisma = {
        generalRoomMessage: { findMany: jest.fn().mockResolvedValue(rows) },
      };
      return new GeneralRoomMessageRepository(prisma as never);
    };

    // Non-active member (left, still browsing PUBLIC history): own join line hidden.
    const left = await makeRepo().findByRoomIdTimeline({
      roomId: ROOM_ID,
      userId: USER_ID,
      direction: "before",
      ts: new Date(),
      limit: 30,
      viewerIsActiveMember: false,
    });
    expect(left.map((m) => m.id)).toEqual(["msg"]);

    // Active member: own current-session join line is visible.
    const active = await makeRepo().findByRoomIdTimeline({
      roomId: ROOM_ID,
      userId: USER_ID,
      direction: "before",
      ts: new Date(),
      limit: 30,
      viewerIsActiveMember: true,
    });
    expect(active.map((m) => m.id)).toEqual(["join", "msg"]);
  });

  // -------------------------------------------------------------------------
  // Suppressed moderation lines (removed / banned / unbanned) are hidden from
  // EVERYONE — including active members — clears history that piled up before
  // the silent-kick rule (Telegram parity).
  // -------------------------------------------------------------------------
  it("hides all membership-lifecycle lines (removed/banned/unbanned/left/joined) from everyone, even active members", async () => {
    const rows = [
      { id: "removed", deletedBy: [], systemMessageType: "MEMBER_REMOVED" },
      { id: "banned", deletedBy: [], systemMessageType: "MEMBER_BANNED" },
      { id: "unbanned", deletedBy: [], systemMessageType: "MEMBER_UNBANNED" },
      { id: "left", deletedBy: [], systemMessageType: "MEMBER_LEFT" },
      // Legacy community-wide join line — hidden so it can't duplicate the
      // personal "You joined the community" (own row, would personalize to "You").
      {
        id: "joined",
        deletedBy: [],
        systemMessageType: "MEMBER_JOINED",
        visibleToUserId: null,
      },
      { id: "rolechg", deletedBy: [], systemMessageType: "ROLE_CHANGED" }, // not hidden
      { id: "msg", deletedBy: [] }, // regular message
    ];
    const prisma = {
      generalRoomMessage: { findMany: jest.fn().mockResolvedValue(rows) },
    };
    const repo = new GeneralRoomMessageRepository(prisma as never);

    const result = await repo.findByRoomIdTimeline({
      roomId: ROOM_ID,
      userId: USER_ID,
      direction: "before",
      ts: new Date(),
      limit: 30,
      viewerIsActiveMember: true,
    });

    expect(result.map((m) => m.id)).toEqual(["rolechg", "msg"]);
  });

  it("joiner with a legacy MEMBER_JOINED + personal COMMUNITY_JOINED sees exactly ONE join line (the duplicate fix)", async () => {
    const rows = [
      // Legacy community-wide join line (would personalize to "You joined…" for
      // the joiner) — the source of the duplicate.
      {
        id: "legacy-joined",
        deletedBy: [],
        visibleToUserId: null,
        systemMessageType: "MEMBER_JOINED",
      },
      // The current personal onboarding line.
      {
        id: "personal-joined",
        deletedBy: [],
        visibleToUserId: USER_ID,
        systemMessageType: "COMMUNITY_JOINED",
      },
      { id: "msg", deletedBy: [] },
    ];
    const prisma = {
      generalRoomMessage: { findMany: jest.fn().mockResolvedValue(rows) },
    };
    const repo = new GeneralRoomMessageRepository(prisma as never);

    const result = await repo.findByRoomIdTimeline({
      roomId: ROOM_ID,
      userId: USER_ID,
      direction: "before",
      ts: new Date(),
      limit: 30,
      viewerIsActiveMember: true,
    });

    // Legacy MEMBER_JOINED hidden → exactly the single personal line survives.
    expect(result.map((m) => m.id)).toEqual(["personal-joined", "msg"]);
    expect(
      result.filter((m) =>
        ["MEMBER_JOINED", "COMMUNITY_JOINED"].includes(
          (m as { systemMessageType?: string }).systemMessageType ?? ""
        )
      )
    ).toHaveLength(1);
  });

  it("raw catch-up match excludes suppressed moderation types via $nin", async () => {
    const aggregateRaw = jest.fn().mockResolvedValue([]);
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { generalRoomMessage: { aggregateRaw, findMany } };
    const repo = new GeneralRoomMessageRepository(prisma as never);

    await repo.findSinceId({
      roomId: ROOM_ID,
      userId: USER_ID,
      sinceId: "",
      limit: 20,
    });

    const match = aggregateRaw.mock.calls[0][0].pipeline.find(
      (s: Record<string, unknown>) => "$match" in s
    ).$match;
    expect(match.systemMessageType).toEqual({
      $nin: [
        "MEMBER_REMOVED",
        "MEMBER_BANNED",
        "MEMBER_UNBANNED",
        "MEMBER_LEFT",
        "MEMBER_JOINED",
      ],
    });
  });

  it("conversation count match excludes suppressed moderation types via $nin", async () => {
    const aggregateRaw = jest.fn().mockResolvedValue([{ total: 0 }]);
    const prisma = { generalRoomMessage: { aggregateRaw } };
    const repo = new GeneralRoomMessageRepository(prisma as never);

    await repo.countConversation({
      roomId: ROOM_ID,
      userId: USER_ID,
      beforeMs: 1_700_000_000_000,
    });

    const match = aggregateRaw.mock.calls[0][0].pipeline[0].$match;
    expect(match.systemMessageType).toEqual({
      $nin: [
        "MEMBER_REMOVED",
        "MEMBER_BANNED",
        "MEMBER_UNBANNED",
        "MEMBER_LEFT",
        "MEMBER_JOINED",
      ],
    });
  });

  it("bulk unread count excludes suppressed moderation types via $nin", async () => {
    const aggregateRaw = jest.fn().mockResolvedValue([]);
    const prisma = { generalRoomMessage: { aggregateRaw } };
    const repo = new GeneralRoomMessageRepository(prisma as never);

    await repo.countUnreadBulk({
      userId: USER_ID,
      thresholds: [{ roomId: ROOM_ID, afterDate: new Date(0) }],
    });

    const match = aggregateRaw.mock.calls[0][0].pipeline[0].$match;
    expect(match.systemMessageType).toEqual({
      $nin: [
        "MEMBER_REMOVED",
        "MEMBER_BANNED",
        "MEMBER_UNBANNED",
        "MEMBER_LEFT",
        "MEMBER_JOINED",
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// assertCommunityReadAccess — PUBLIC vs PRIVATE membership rules. The community
// visibility is read from the GeneralRoom (`communityType`), only for non-members.
// ---------------------------------------------------------------------------
describe("assertCommunityReadAccess", () => {
  const makeMemberRepo = (status: string | null) => ({
    findByRoomAndUser: jest
      .fn()
      .mockResolvedValue(status === null ? null : { status, role: "member" }),
  });
  const makeRoomRepo = (communityType: string | null) => ({
    findRoomById: jest
      .fn()
      .mockResolvedValue({ id: ROOM_ID, status: "active", communityType }),
  });

  it("allows an ACTIVE member without loading the room", async () => {
    const roomRepo = makeRoomRepo("PRIVATE");
    const res = await assertCommunityReadAccess(
      roomRepo as never,
      makeMemberRepo("active") as never,
      ROOM_ID,
      USER_ID
    );
    expect(res.canRead).toBe(true);
    expect(res.member).not.toBeNull();
    // Members short-circuit — the room (visibility) is never loaded.
    expect(roomRepo.findRoomById).not.toHaveBeenCalled();
  });

  it("allows a NON-member to read a PUBLIC community", async () => {
    const res = await assertCommunityReadAccess(
      makeRoomRepo("PUBLIC") as never,
      makeMemberRepo(null) as never,
      ROOM_ID,
      USER_ID
    );
    expect(res.canRead).toBe(true);
    expect(res.member).toBeNull();
  });

  it("blocks a NON-member from a PRIVATE community", async () => {
    await expect(
      assertCommunityReadAccess(
        makeRoomRepo("PRIVATE") as never,
        makeMemberRepo(null) as never,
        ROOM_ID,
        USER_ID
      )
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("fails closed (blocks) when the room's communityType is unsynced (null)", async () => {
    await expect(
      assertCommunityReadAccess(
        makeRoomRepo(null) as never,
        makeMemberRepo(null) as never,
        ROOM_ID,
        USER_ID
      )
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("blocks a BANNED user even when the community is PUBLIC", async () => {
    await expect(
      assertCommunityReadAccess(
        makeRoomRepo("PUBLIC") as never,
        makeMemberRepo("banned") as never,
        ROOM_ID,
        USER_ID
      )
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// CommunityMessageService.getMessages — routes through the read-access guard
// ---------------------------------------------------------------------------
describe("CommunityMessageService.getMessages access", () => {
  function build(memberStatus: string | null, communityType: string | null) {
    const messageRepo = {
      findByRoomIdWithTime: jest.fn().mockResolvedValue([]),
    };
    const roomRepo = {
      findRoomById: jest
        .fn()
        .mockResolvedValue({ id: ROOM_ID, status: "active", communityType }),
    };
    const memberRepo = {
      findByRoomAndUser: jest
        .fn()
        .mockResolvedValue(
          memberStatus === null
            ? null
            : { status: memberStatus, role: "member" }
        ),
      findReadStatusByRoom: jest.fn().mockResolvedValue([]),
    };
    const cacheRepo = {};
    const userSnapshotService = {};
    const service = new CommunityMessageService(
      messageRepo as never,
      roomRepo as never,
      memberRepo as never,
      cacheRepo as never,
      userSnapshotService as never
    );
    return { service, messageRepo };
  }

  it("non-member can read a PUBLIC community history", async () => {
    const { service, messageRepo } = build(null, "PUBLIC");
    await expect(
      service.getMessages({ roomId: ROOM_ID, userId: USER_ID, limit: 30 })
    ).resolves.toEqual([]);
    expect(messageRepo.findByRoomIdWithTime).toHaveBeenCalled();
  });

  it("non-member is blocked from a PRIVATE community history", async () => {
    const { service, messageRepo } = build(null, "PRIVATE");
    await expect(
      service.getMessages({ roomId: ROOM_ID, userId: USER_ID, limit: 30 })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(messageRepo.findByRoomIdWithTime).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CommunitySystemMessageService — PERSONAL join message targeting
// ---------------------------------------------------------------------------
describe("CommunitySystemMessageService PERSONAL join message", () => {
  function build() {
    const created = {
      id: "m".repeat(24),
      sentBy: USER_ID,
      senderName: "Bob",
      message: "You joined the community",
      messageType: "SYSTEM",
      createdAt: new Date(),
    };
    const messageRepo = {
      createSystemMessage: jest.fn().mockResolvedValue(created),
    };
    const roomRepo = {
      allocateSequence: jest.fn().mockResolvedValue(1),
      addLastestMessageToRoom: jest.fn().mockResolvedValue(undefined),
    };
    const cacheRepo = {};
    const userSnapshotService = {
      // Resolve every requested id → "Bob" so actor/target names interpolate.
      getUserSnapshotsMap: jest.fn(
        async (ids: string[]) =>
          new Map(ids.map((id) => [id, { displayName: "Bob" }]))
      ),
    };
    const publish = jest.fn().mockResolvedValue(undefined);
    const redis = { publish };
    const service = new CommunitySystemMessageService(
      messageRepo as never,
      roomRepo as never,
      cacheRepo as never,
      userSnapshotService as never,
      redis as never
    );
    return { service, messageRepo, roomRepo, publish };
  }

  it("derives PERSONAL visibility from the registry → persists visibleToUserId + publishes to user:<id> only", async () => {
    const { service, messageRepo, roomRepo, publish } = build();

    // NOTE: no visibilityType passed — it's derived from SYSTEM_MESSAGE_VISIBILITY.
    await service.post({
      communityId: ROOM_ID,
      systemMessageType: "COMMUNITY_JOINED",
      metadata: {},
      triggeredByUserId: USER_ID,
      visibleToUserId: USER_ID,
    });

    expect(messageRepo.createSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ visibleToUserId: USER_ID })
    );
    const channels = publish.mock.calls.map((c) => c[0]);
    expect(channels).toContain(`user:${USER_ID}`);
    expect(channels).not.toContain(`community:${ROOM_ID}`);
    // PERSONAL + non-bumping subtype → no list reorder.
    expect(roomRepo.addLastestMessageToRoom).not.toHaveBeenCalled();
  });

  it("JOIN_REQUEST_APPROVED is also registry-PERSONAL (user channel)", async () => {
    const { service, publish } = build();
    await service.post({
      communityId: ROOM_ID,
      systemMessageType: "JOIN_REQUEST_APPROVED",
      metadata: {},
      triggeredByUserId: USER_ID,
      visibleToUserId: USER_ID,
    });
    const channels = publish.mock.calls.map((c) => c[0]);
    expect(channels).toEqual([`user:${USER_ID}`]);
  });

  it("COMMUNITY subtypes publish to the room and the wire is SENDER-LESS", async () => {
    const { service, roomRepo, publish } = build();

    // UNPINNED_MESSAGE: a COMMUNITY-visible, non-bumping subtype (MEMBER_JOINED is
    // now a hidden membership-lifecycle line, so it's no longer a good example).
    await service.post({
      communityId: ROOM_ID,
      systemMessageType: "UNPINNED_MESSAGE",
      metadata: {},
      triggeredByUserId: OTHER_ID,
    });

    const [channel, payload] = publish.mock.calls[0];
    expect(channel).toBe(`community:${ROOM_ID}`);
    const data = JSON.parse(payload).data;
    // Sender-less: no senderId / senderName / senderAvatar on a SYSTEM message.
    expect(data.senderId).toBe("");
    expect(data.senderName).toBe("");
    expect(data.senderAvatar).toBe("");
    expect(data.systemMessageType).toBe("UNPINNED_MESSAGE");
    expect(data.isPersonal).toBe(false);
    // Low-signal lines must not reorder the community list for other members.
    expect(roomRepo.addLastestMessageToRoom).not.toHaveBeenCalled();
  });

  it("renders deterministic Telegram-style template text per subtype", async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["COMMUNITY_CREATED", {}, "Community created"],
      ["COMMUNITY_NAME_UPDATED", {}, "Community name updated"],
      ["COMMUNITY_DESCRIPTION_UPDATED", {}, "Community description updated"],
      ["COMMUNITY_AVATAR_UPDATED", {}, "Community photo updated"],
      ["COMMUNITY_BANNER_UPDATED", {}, "Community banner updated"],
      ["COMMUNITY_UPDATED", {}, "Community details updated"],
      // NOTE: MEMBER_REMOVED / MEMBER_BANNED / MEMBER_LEFT / MEMBER_JOINED are
      // hidden membership lines — post() drops them, so they're not exercised here.
      [
        "ROLE_CHANGED",
        { targetUserId: OTHER_ID, newRole: "ADMIN", oldRole: "MEMBER" },
        "Bob is now an admin",
      ],
      ["COMMUNITY_JOINED", {}, "You joined the community"],
      ["JOIN_REQUEST_APPROVED", {}, "Your request to join was approved"],
      ["JOIN_REQUEST_REJECTED", {}, "Your request to join was declined"],
    ];

    for (const [type, metadata, expected] of cases) {
      const { service, messageRepo } = build();
      // Snapshot resolves OTHER_ID → "Bob" so the target name interpolates.
      await service.post({
        communityId: ROOM_ID,
        systemMessageType: type as never,
        metadata,
        triggeredByUserId: OTHER_ID,
        visibleToUserId: OTHER_ID,
      });
      const arg = messageRepo.createSystemMessage.mock.calls[0][0];
      expect(arg.fallbackText).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Pin / unpin emit PINNED_MESSAGE / UNPINNED_MESSAGE SYSTEM lines
// ---------------------------------------------------------------------------
describe("Community pin/unpin → system messages", () => {
  const MOD = { status: "active", role: "admin" };
  const MSG_ID = "m".repeat(24);

  it("CommunityPinService.pin emits PINNED_MESSAGE", async () => {
    const post = jest.fn().mockResolvedValue(undefined);
    const svc = new CommunityPinService(
      {
        countPinsByRoom: jest.fn().mockResolvedValue(0),
        createPin: jest.fn().mockResolvedValue({ id: "p" }),
      } as never,
      {
        findById: jest.fn().mockResolvedValue({
          id: MSG_ID,
          roomId: ROOM_ID,
          message: "hi",
          createdAt: new Date(),
        }),
      } as never,
      {
        incPinnedCount: jest.fn().mockResolvedValue({ pinnedCount: 1 }),
      } as never,
      { findByRoomAndUser: jest.fn().mockResolvedValue(MOD) } as never,
      { post } as never
    );

    await svc.pin({
      roomId: ROOM_ID,
      messageId: MSG_ID,
      userId: USER_ID,
      communityId: ROOM_ID,
    });

    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: ROOM_ID,
        systemMessageType: "PINNED_MESSAGE",
        triggeredByUserId: USER_ID,
      })
    );
  });

  it("CommunityPinService.unpin emits UNPINNED_MESSAGE", async () => {
    const post = jest.fn().mockResolvedValue(undefined);
    const svc = new CommunityPinService(
      { deletePin: jest.fn().mockResolvedValue({ deletedCount: 1 }) } as never,
      {} as never,
      {
        incPinnedCount: jest.fn().mockResolvedValue({ pinnedCount: 0 }),
      } as never,
      { findByRoomAndUser: jest.fn().mockResolvedValue(MOD) } as never,
      { post } as never
    );

    await svc.unpin({ roomId: ROOM_ID, messageId: MSG_ID, userId: USER_ID });

    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: ROOM_ID,
        systemMessageType: "UNPINNED_MESSAGE",
        triggeredByUserId: USER_ID,
      })
    );
  });

  it("CommunityMessageService.pinMessage (gRPC path) emits PINNED_MESSAGE", async () => {
    const post = jest.fn().mockResolvedValue(undefined);
    const svc = new CommunityMessageService(
      {
        findById: jest.fn().mockResolvedValue({
          id: MSG_ID,
          roomId: ROOM_ID,
          messageType: "TEXT",
          deletedForAll: false,
        }),
      } as never,
      {
        findRoomById: jest.fn().mockResolvedValue({
          id: ROOM_ID,
          status: "active",
          listPinedMessage: [],
        }),
        updatePinnedMessages: jest.fn().mockResolvedValue(undefined),
      } as never,
      { findByRoomAndUser: jest.fn().mockResolvedValue(MOD) } as never,
      {} as never,
      {} as never,
      { post } as never
    );

    await svc.pinMessage({
      messageId: MSG_ID,
      userId: USER_ID,
      roomId: ROOM_ID,
      communityId: ROOM_ID,
    });

    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ systemMessageType: "PINNED_MESSAGE" })
    );
  });
});
