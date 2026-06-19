/**
 * Telegram-style community history access + personal system-message visibility.
 *
 * Covers two requirements:
 *  1. PUBLIC communities let non-members read message history; PRIVATE communities
 *     block non-members (and banned users in either case) with CHAT_NOT_A_MEMBER.
 *  2. The "You joined this community" SYSTEM message is PERSONAL: persisted with a
 *     `visibleToUserId`, published to `user:<id>` (not the community room), and never
 *     surfaced to other members.
 */
import { ForbiddenError } from "@aimess/errors";

import { assertCommunityReadAccess } from "../../src/lib/access-guard.js";
import { CommunityMessageService } from "../../src/services/community-message.service.js";
import { CommunitySystemMessageService } from "../../src/services/community-system-message.service.js";

const ROOM_ID = "c".repeat(24);
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

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
      message: "You joined this community",
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
      getUserSnapshotsMap: jest
        .fn()
        .mockResolvedValue(new Map([[USER_ID, { displayName: "Bob" }]])),
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

  it("persists with visibleToUserId and publishes to user:<id> (not the room)", async () => {
    const { service, messageRepo, roomRepo, publish } = build();

    await service.post({
      communityId: ROOM_ID,
      systemMessageType: "COMMUNITY_JOINED",
      metadata: {},
      triggeredByUserId: USER_ID,
      visibilityType: "PERSONAL",
      visibleToUserId: USER_ID,
    });

    // Stored as a personal message targeted at the joiner.
    expect(messageRepo.createSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ visibleToUserId: USER_ID })
    );

    // Real-time fan-out goes to the joiner's personal channel only.
    const channels = publish.mock.calls.map((c) => c[0]);
    expect(channels).toContain(`user:${USER_ID}`);
    expect(channels).not.toContain(`community:${ROOM_ID}`);

    // PERSONAL messages don't bump the room's last-message ordering.
    expect(roomRepo.addLastestMessageToRoom).not.toHaveBeenCalled();
  });

  it("COMMUNITY messages still publish to the community room", async () => {
    const { service, publish } = build();

    await service.post({
      communityId: ROOM_ID,
      systemMessageType: "COMMUNITY_CREATED",
      metadata: { communityName: "Test" },
      triggeredByUserId: OTHER_ID,
    });

    const channels = publish.mock.calls.map((c) => c[0]);
    expect(channels).toContain(`community:${ROOM_ID}`);
    expect(channels).not.toContain(`user:${OTHER_ID}`);
  });
});
