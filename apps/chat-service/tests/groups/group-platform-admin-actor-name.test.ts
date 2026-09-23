/**
 * Root-cause regression for "Someone removed <member>" in a Group timeline.
 *
 * The line is rebuilt from `systemData` on EVERY read (history and socket alike),
 * so it can only be fixed at write time. A backoffice removal used to post
 * `actorId: null` with no name at all — the acting admin lives in admin_db,
 * which chat-service cannot read — and `buildGroupSystemFallbackText` therefore
 * fell through to its neutral "Someone" wording for every member, permanently.
 *
 * backoffice-service now forwards the admin's display name, and
 * `GroupSystemMessageService` accepts it as a FALLBACK ONLY: a real chat actor
 * is still named from the live snapshot, so a caller can never bake a stale name
 * onto a normal member-to-member removal.
 */
import { GroupSystemMessageService } from "../../src/services/group-system-message.service.js";
import { GroupMemberService } from "../../src/services/group-member.service.js";

const CREATED_AT = new Date("2026-09-23T09:00:00.000Z");

function buildService() {
  const stubs = {
    messageRepo: {
      findByClientMessageId: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async (data) => ({
        id: "msg-1",
        ...data,
        senderId: data.senderId ?? null,
        createdAt: CREATED_AT,
      })),
    },
    roomRepo: {
      allocateSequence: jest.fn().mockResolvedValue(3),
      updateLastMessage: jest.fn().mockResolvedValue({}),
      findByRoomId: jest.fn().mockResolvedValue({ roomId: "grp-1" }),
    },
    memberRepo: {
      incUnreadForRoom: jest.fn().mockResolvedValue({}),
      findActiveMembers: jest
        .fn()
        .mockResolvedValue([{ userId: "u1" }, { userId: "u2" }]),
    },
    cacheRepo: {},
    userSnapshotService: {
      getUserSnapshotsMap: jest.fn().mockImplementation(async (ids: string[]) =>
        new Map(
          ids
            .filter((id) => id.startsWith("user-"))
            .map((id) => [id, { displayName: `Name ${id}` }])
        )
      ),
    },
    redis: { publish: jest.fn().mockResolvedValue(1) },
  };
  const service = new GroupSystemMessageService(
    stubs.messageRepo as never,
    stubs.roomRepo as never,
    stubs.memberRepo as never,
    stubs.cacheRepo as never,
    stubs.userSnapshotService as never,
    stubs.redis as never
  );
  return { service, stubs };
}

/** The persisted row, as `messageRepo.create` received it. */
const storedRow = (stubs: ReturnType<typeof buildService>["stubs"]) =>
  stubs.messageRepo.create.mock.calls[0]![0] as {
    senderId: string | null;
    systemData: Record<string, unknown>;
    content: { text: string };
  };

describe("GroupSystemMessageService — platform-admin actor name", () => {
  it("POSITIVE: a caller-supplied name names an actor-less removal", async () => {
    const { service, stubs } = buildService();

    await service.post({
      roomId: "grp-1",
      actorId: null,
      systemEvent: "MEMBER_REMOVED" as never,
      systemData: { targetUserId: "user-2", actorName: "Super Admin" },
      skipAdminActivity: true,
    });

    const row = storedRow(stubs);
    expect(row.content.text).toBe("Super Admin removed Name user-2");
    expect(row.systemData.actorName).toBe("Super Admin");
    // Named, but still nobody's action: an AdminUser id is not a chat user, so
    // no viewer may ever read this row as "You removed …".
    expect(row.systemData.actorId).toBeNull();
  });

  it("NEGATIVE: a supplied name never overrides a real chat actor", async () => {
    const { service, stubs } = buildService();

    await service.post({
      roomId: "grp-1",
      actorId: "user-1",
      systemEvent: "MEMBER_REMOVED" as never,
      systemData: { targetUserId: "user-2", actorName: "Impostor" },
    });

    const row = storedRow(stubs);
    expect(row.systemData.actorName).toBe("Name user-1");
    expect(row.content.text).toBe("Name user-1 removed Name user-2");
  });

  it("NEGATIVE: with no name at all the row stays honestly actor-less", async () => {
    const { service, stubs } = buildService();

    await service.post({
      roomId: "grp-1",
      actorId: null,
      systemEvent: "MEMBER_REMOVED" as never,
      systemData: { targetUserId: "user-2" },
      skipAdminActivity: true,
    });

    expect(storedRow(stubs).content.text).toBe("Someone removed Name user-2");
  });

  it("POSITIVE: the socket payload carries the same named systemData", async () => {
    const { service, stubs } = buildService();

    await service.post({
      roomId: "grp-1",
      actorId: null,
      systemEvent: "MEMBER_REMOVED" as never,
      systemData: { targetUserId: "user-2", actorName: "Super Admin" },
      excludeUserId: "user-2",
      skipAdminActivity: true,
    });

    const published = stubs.redis.publish.mock.calls.find(
      (call) => call[0] === "conv:grp-1"
    )!;
    const payload = JSON.parse(published[1] as string);
    expect(payload.event).toBe("message:new");
    // Realtime and a later history read rebuild from THIS object, so carrying
    // the name here is what keeps the two surfaces from disagreeing.
    expect(payload.data.systemData.actorName).toBe("Super Admin");
    expect(payload.data.content.text).toBe("Super Admin removed Name user-2");
    // The removed member still never receives their own removal line.
    expect(payload.excludeUserId).toBe("user-2");
  });

  it("NEGATIVE: a removal still never bumps the conversation list", async () => {
    const { service, stubs } = buildService();

    await service.post({
      roomId: "grp-1",
      actorId: null,
      systemEvent: "MEMBER_REMOVED" as never,
      systemData: { targetUserId: "user-2", actorName: "Super Admin" },
      skipAdminActivity: true,
    });

    expect(stubs.roomRepo.updateLastMessage).not.toHaveBeenCalled();
    expect(
      stubs.redis.publish.mock.calls.some((call) =>
        String(call[1]).includes("conv:updated")
      )
    ).toBe(false);
  });
});

/**
 * The membership layer is what decides whether a name is offered at all: an
 * in-group removal must keep resolving its actor from the snapshot, so the
 * backoffice name is only attached on the `asPlatformAdmin` path.
 */
function buildMemberService() {
  const sysMsg = { post: jest.fn().mockResolvedValue(undefined) };
  const memberRepo = {
    findActiveByRoomAndUser: jest.fn().mockImplementation(async (_r, userId) =>
      userId === "target-1"
        ? { userId: "target-1", role: "MEMBER", status: "ACTIVE" }
        : { userId, role: "ADMIN", status: "ACTIVE" }
    ),
    updateStatus: jest.fn().mockResolvedValue({ userId: "target-1" }),
  };
  const service = Object.create(GroupMemberService.prototype) as GroupMemberService;
  Object.assign(service, {
    sysMsg,
    memberRepo,
    roomRepo: { incMemberCount: jest.fn().mockResolvedValue({}) },
    emitGroupRemoved: jest.fn(),
    publishRosterChange: jest.fn().mockResolvedValue(undefined),
  });
  return { service, sysMsg };
}

describe("GroupMemberService.kick — who gets named", () => {
  it("POSITIVE: a backoffice removal forwards the admin's name", async () => {
    const { service, sysMsg } = buildMemberService();

    await service.kick({
      roomId: "grp-1",
      targetUserId: "target-1",
      kickedBy: "admin-user-1",
      asPlatformAdmin: true,
      actorDisplayName: "Super Admin",
    });

    expect(sysMsg.post).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: null,
        systemData: {
          targetUserId: "target-1",
          actorName: "Super Admin",
        },
        excludeUserId: "target-1",
      })
    );
  });

  it("NEGATIVE: an in-group removal attaches no name, so the snapshot wins", async () => {
    const { service, sysMsg } = buildMemberService();

    await service.kick({
      roomId: "grp-1",
      targetUserId: "target-1",
      kickedBy: "actor-1",
      // Ignored: the actor is a real member and must be named live.
      actorDisplayName: "Super Admin",
    });

    expect(sysMsg.post).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "actor-1",
        systemData: { targetUserId: "target-1" },
      })
    );
  });
});

describe("GroupMemberService.ban / unban — who gets named", () => {
  it("POSITIVE: a backoffice ban forwards the admin's name", async () => {
    const { service, sysMsg } = buildMemberService();

    await service.ban({
      roomId: "grp-1",
      targetUserId: "target-1",
      bannedBy: "admin-user-1",
      asPlatformAdmin: true,
      actorDisplayName: "Super Admin",
    });

    expect(sysMsg.post).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: null,
        systemData: { targetUserId: "target-1", actorName: "Super Admin" },
        excludeUserId: "target-1",
      })
    );
  });

  it("POSITIVE: a backoffice unban forwards the admin's name", async () => {
    const { service, sysMsg } = buildMemberService();
    (
      service as unknown as { memberRepo: { findByRoomAndUser: jest.Mock } }
    ).memberRepo.findByRoomAndUser = jest
      .fn()
      .mockResolvedValue({ userId: "target-1", status: "BANNED" });

    await service.unban({
      roomId: "grp-1",
      targetUserId: "target-1",
      unbannedBy: "admin-user-1",
      asPlatformAdmin: true,
      actorDisplayName: "Super Admin",
    });

    expect(sysMsg.post).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: null,
        systemData: { targetUserId: "target-1", actorName: "Super Admin" },
      })
    );
  });

  it("NEGATIVE: an in-group ban still resolves its actor from the snapshot", async () => {
    const { service, sysMsg } = buildMemberService();

    await service.ban({
      roomId: "grp-1",
      targetUserId: "target-1",
      bannedBy: "actor-1",
      actorDisplayName: "Super Admin",
    });

    expect(sysMsg.post).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "actor-1",
        systemData: { targetUserId: "target-1" },
      })
    );
  });
});
