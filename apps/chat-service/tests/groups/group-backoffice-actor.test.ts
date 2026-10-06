/**
 * A Super Admin acting from Backoffice is named "Administrator" on every group
 * surface — the stored row, the realtime frame, REST history/sync/catchup — and
 * the admin's real name never reaches a member.
 *
 * New rows are posted actor-less with `source: "BO"` and no admin name. Legacy
 * rows (an earlier build baked the admin's real name into `systemData.actorName`
 * and `senderName`) are scrubbed by `toWireMessage` on every read.
 */
import { GroupSystemMessageService } from "../../src/services/group-system-message.service.js";
import { GroupMemberService } from "../../src/services/group-member.service.js";
import { toWireMessage } from "../../src/lib/chat-message.serializer.js";

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

describe("GroupSystemMessageService — Backoffice actor", () => {
  it("POSITIVE: a Backoffice removal is stored as 'Administrator', with no admin name", async () => {
    const { service, stubs } = buildService();

    await service.post({
      roomId: "grp-1",
      actorId: null,
      systemEvent: "MEMBER_REMOVED" as never,
      systemData: { targetUserId: "user-2", source: "BO" },
      skipAdminActivity: true,
    });

    const row = storedRow(stubs) as ReturnType<typeof storedRow> & {
      senderName: string;
    };
    expect(row.content.text).toBe(
      "Administrator removed Name user-2 from the group"
    );
    expect(row.systemData.source).toBe("BO");
    expect(row.systemData.actorName).toBe("");
    expect(row.senderName).toBe("");
    // Nobody's action: no viewer may read this row as "You removed …".
    expect(row.systemData.actorId).toBeNull();
  });

  it("NEGATIVE: a caller-supplied actorName is never stored or shown", async () => {
    const { service, stubs } = buildService();

    await service.post({
      roomId: "grp-1",
      actorId: null,
      systemEvent: "MEMBER_BANNED" as never,
      systemData: { targetUserId: "user-2", actorName: "Rajesh Sharma" },
      skipAdminActivity: true,
    });

    const row = storedRow(stubs);
    expect(row.systemData.actorName).toBe("");
    expect(row.content.text).toBe("Administrator banned Name user-2");
  });

  it("NEGATIVE: a real chat actor is still named from the live snapshot", async () => {
    const { service, stubs } = buildService();

    await service.post({
      roomId: "grp-1",
      actorId: "user-1",
      systemEvent: "MEMBER_REMOVED" as never,
      systemData: { targetUserId: "user-2", actorName: "Impostor" },
    });

    const row = storedRow(stubs);
    expect(row.systemData.actorName).toBe("Name user-1");
    expect(row.content.text).toBe(
      "Name user-1 removed Name user-2 from the group"
    );
  });

  it("POSITIVE: the realtime frame matches the stored row", async () => {
    const { service, stubs } = buildService();

    await service.post({
      roomId: "grp-1",
      actorId: null,
      systemEvent: "MEMBER_BANNED" as never,
      systemData: { targetUserId: "user-2", source: "BO" },
      excludeUserId: "user-2",
      skipAdminActivity: true,
    });

    const published = stubs.redis.publish.mock.calls.find(
      (call) => call[0] === "conv:grp-1"
    )!;
    const payload = JSON.parse(published[1] as string);
    expect(payload.event).toBe("message:new");
    expect(payload.data.content.text).toBe("Administrator banned Name user-2");
    expect(payload.data.systemData.source).toBe("BO");
    expect(payload.data.senderName).toBe("");
    // The banned member still never receives their own ban line.
    expect(payload.excludeUserId).toBe("user-2");
  });

  it("NEGATIVE: a removal still never bumps the conversation list", async () => {
    const { service, stubs } = buildService();

    await service.post({
      roomId: "grp-1",
      actorId: null,
      systemEvent: "MEMBER_REMOVED" as never,
      systemData: { targetUserId: "user-2", source: "BO" },
      skipAdminActivity: true,
    });

    expect(stubs.roomRepo.updateLastMessage).not.toHaveBeenCalled();
  });
});

describe("toWireMessage — legacy Backoffice rows", () => {
  // Exactly what the retired name-forwarding build persisted.
  const legacy = {
    id: "m1",
    messageType: "SYSTEM",
    senderId: null,
    senderName: "Rajesh Sharma",
    systemEvent: "MEMBER_BANNED",
    systemData: {
      actorId: null,
      actorName: "Rajesh Sharma",
      targetUserId: "user-2",
      targetName: "Tom",
    },
    content: { text: "Rajesh Sharma banned Tom", urls: [], files: [] },
  };

  it("POSITIVE: drops the admin name and re-renders 'Administrator'", () => {
    const wire = toWireMessage(legacy) as unknown as Record<string, unknown>;
    expect(JSON.stringify(wire)).not.toContain("Rajesh");
    expect((wire.content as { text: string }).text).toBe(
      "Administrator banned Tom"
    );
    expect(wire.senderName).toBe("");
    expect((wire.systemData as Record<string, unknown>).targetName).toBe("Tom");
  });

  it("NEGATIVE: an in-group line passes through untouched", () => {
    const inGroup = {
      ...legacy,
      senderId: "user-1",
      senderName: "Group Owner",
      systemData: {
        ...legacy.systemData,
        actorId: "user-1",
        actorName: "Group Owner",
      },
      content: { text: "Group Owner banned Tom", urls: [], files: [] },
    };
    const wire = toWireMessage(inGroup) as unknown as Record<string, unknown>;
    expect(wire.senderName).toBe("Group Owner");
    expect(wire.content).toEqual(inGroup.content);
  });

  it("NEGATIVE: a non-system row is untouched", () => {
    const text = {
      id: "m2",
      messageType: "TEXT",
      senderName: "A",
      content: { text: "hi" },
    };
    expect(toWireMessage(text)).toEqual({
      id: "m2",
      senderName: "A",
      content: { text: "hi" },
      contentType: "TEXT",
    });
  });
});

/**
 * The membership layer marks a Backoffice action `source: "BO"` on the
 * `asPlatformAdmin` path only; an in-group action keeps its member actor.
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

describe("GroupMemberService.kick — Backoffice marker", () => {
  it("POSITIVE: a Backoffice removal is marked source BO, actor-less", async () => {
    const { service, sysMsg } = buildMemberService();

    await service.kick({
      roomId: "grp-1",
      targetUserId: "target-1",
      kickedBy: "admin-user-1",
      asPlatformAdmin: true,
    });

    expect(sysMsg.post).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: null,
        systemData: { targetUserId: "target-1", source: "BO" },
        excludeUserId: "target-1",
      })
    );
  });

  it("NEGATIVE: an in-group removal is not marked Backoffice", async () => {
    const { service, sysMsg } = buildMemberService();

    await service.kick({
      roomId: "grp-1",
      targetUserId: "target-1",
      kickedBy: "actor-1",
    });

    expect(sysMsg.post).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "actor-1",
        systemData: { targetUserId: "target-1" },
      })
    );
  });
});

describe("GroupMemberService.ban / unban — Backoffice marker", () => {
  it("POSITIVE: a Backoffice ban is marked source BO, actor-less", async () => {
    const { service, sysMsg } = buildMemberService();

    await service.ban({
      roomId: "grp-1",
      targetUserId: "target-1",
      bannedBy: "admin-user-1",
      asPlatformAdmin: true,
    });

    expect(sysMsg.post).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: null,
        systemData: { targetUserId: "target-1", source: "BO" },
        excludeUserId: "target-1",
      })
    );
  });

  it("POSITIVE: a Backoffice unban is marked source BO, actor-less", async () => {
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
    });

    expect(sysMsg.post).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: null,
        systemData: { targetUserId: "target-1", source: "BO" },
      })
    );
  });

  it("NEGATIVE: an in-group ban is not marked Backoffice", async () => {
    const { service, sysMsg } = buildMemberService();

    await service.ban({
      roomId: "grp-1",
      targetUserId: "target-1",
      bannedBy: "actor-1",
    });

    expect(sysMsg.post).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "actor-1",
        systemData: { targetUserId: "target-1" },
      })
    );
  });
});
