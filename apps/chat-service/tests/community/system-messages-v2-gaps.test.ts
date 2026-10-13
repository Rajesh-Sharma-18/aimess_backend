/**
 * System Messages v2 gaps: closed community = COMMUNITY_IS_CLOSED for all but
 * its admin; admin open/mark-read counts as admin activity; system lines name
 * the actor except platform/automatic ones; mandatory System inbox types.
 */
jest.mock("../../src/events/publish-community-activity.js", () => ({
  publishCommunityActivitySafe: jest.fn(),
  publishAdminActiveSafe: jest.fn(),
}));

import {
  assertCommunityOpenFor,
  assertCommunityReadAccess,
  assertCommunityRoomWritable,
} from "../../src/lib/access-guard.js";
import { publishAdminActiveSafe } from "../../src/events/publish-community-activity.js";
import { CommunityMessageService } from "../../src/services/community-message.service.js";
import { CommunitySystemMessageService } from "../../src/services/community-system-message.service.js";
import { categoryWhere, categorizeId } from "../../src/lib/notification-category.js";

const adminActive = publishAdminActiveSafe as jest.Mock;
const ROOM = "c".repeat(24);
const closed = { status: "suspended", communityType: "PUBLIC" };
const admin = { status: "active", role: "admin" };
const member = { status: "active", role: "member" };

function repos(m: unknown, room: unknown = closed) {
  return {
    roomRepo: { findRoomById: jest.fn(async () => room) },
    memberRepo: {
      findByRoomAndUser: jest.fn(async () => m),
      upsert: jest.fn(),
    },
  };
}

async function messageKey(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (e) {
    return (e as Error).message;
  }
}

beforeEach(() => adminActive.mockClear());

describe("closed community gate", () => {
  it("writes: member → COMMUNITY_IS_CLOSED, admin → COMMUNITY_SUSPENDED", () => {
    expect(() => assertCommunityRoomWritable(closed, member as never)).toThrow(
      "COMMUNITY_IS_CLOSED"
    );
    expect(() => assertCommunityRoomWritable(closed, null)).toThrow(
      "COMMUNITY_IS_CLOSED"
    );
    expect(() => assertCommunityRoomWritable(closed, admin as never)).toThrow(
      "COMMUNITY_SUSPENDED"
    );
    expect(() =>
      assertCommunityRoomWritable({ status: "active" }, member as never)
    ).not.toThrow();
  });

  it("open check passes only the admin, and only while closed", () => {
    expect(() => assertCommunityOpenFor(closed, admin as never)).not.toThrow();
    expect(() => assertCommunityOpenFor({ status: "active" }, null)).not.toThrow();
    expect(() => assertCommunityOpenFor(closed, member as never)).toThrow(
      "COMMUNITY_IS_CLOSED"
    );
  });

  it("reads: active member and PUBLIC non-member get COMMUNITY_IS_CLOSED", async () => {
    for (const m of [member, null]) {
      const { roomRepo, memberRepo } = repos(m);
      await expect(
        messageKey(
          assertCommunityReadAccess(roomRepo as never, memberRepo as never, ROOM, "u1")
        )
      ).resolves.toBe("COMMUNITY_IS_CLOSED");
    }
  });

  it("reads: the admin still reads a closed community and counts as active", async () => {
    const { roomRepo, memberRepo } = repos(admin);
    await expect(
      assertCommunityReadAccess(roomRepo as never, memberRepo as never, ROOM, "a1")
    ).resolves.toMatchObject({ canRead: true });
    expect(adminActive).toHaveBeenCalledWith(ROOM, "a1");
  });

  it("reads: a plain member of an open community is not counted as admin activity", async () => {
    const { roomRepo, memberRepo } = repos(member, { status: "active" });
    await assertCommunityReadAccess(roomRepo as never, memberRepo as never, ROOM, "u1");
    expect(adminActive).not.toHaveBeenCalled();
  });
});

describe("markMessageRead", () => {
  function service(m: unknown) {
    const { roomRepo, memberRepo } = repos(m);
    const messageRepo = { findById: jest.fn(async () => null) };
    return new CommunityMessageService(
      messageRepo as never,
      roomRepo as never,
      memberRepo as never,
      {} as never,
      {} as never
    );
  }
  const params = { communityId: ROOM, roomId: ROOM, readerId: "u1", upToMessageId: "m1" };

  it("member of a closed community → COMMUNITY_IS_CLOSED", async () => {
    await expect(messageKey(service(member).markMessageRead(params))).resolves.toBe(
      "COMMUNITY_IS_CLOSED"
    );
    expect(adminActive).not.toHaveBeenCalled();
  });

  it("admin mark-read publishes admin activity", async () => {
    await expect(messageKey(service(admin).markMessageRead(params))).resolves.toBe(
      "CHAT_MESSAGE_NOT_FOUND"
    );
    expect(adminActive).toHaveBeenCalledWith(ROOM, "u1");
  });
});

describe("community system line actor name", () => {
  function make() {
    const createSystemMessage = jest.fn(async () => ({
      id: "msg-1",
      sentBy: "actor-1",
      senderName: "",
      message: "",
      messageType: "SYSTEM",
      createdAt: new Date(),
    }));
    const getUserSnapshotsMap = jest.fn(
      async () => new Map([["actor-1", { displayName: "Minh" }]])
    );
    const service = new CommunitySystemMessageService(
      { findOne: jest.fn(async () => null), createSystemMessage } as never,
      {
        allocateSequenceAndRevision: jest.fn(async () => ({ sequenceNumber: 1, revision: 1 })),
        allocateSequence: jest.fn(async () => 1),
        allocateRevision: jest.fn(async () => 1),
        addLastestMessageToRoom: jest.fn(),
      } as never,
      {} as never,
      { getUserSnapshotsMap } as never,
      { publish: jest.fn(async () => 1) } as never
    );
    return { service, createSystemMessage, getUserSnapshotsMap };
  }
  const meta = (c: jest.Mock) =>
    (c.mock.calls[0] as unknown as [{ metadata: Record<string, unknown> }])[0].metadata;

  it.each(["ROLE_CHANGED", "COMMUNITY_CLOSED", "MEMBER_REMOVED", "MEMBER_UNMUTED"])(
    "%s: empty producer actorName is resolved from the actor id",
    async (type) => {
      const h = make();
      await h.service.post({
        communityId: ROOM,
        systemMessageType: type as never,
        metadata: { actorUserId: "actor-1", actorName: "", actorRole: "ADMIN", targetUserId: "t1" },
        triggeredByUserId: "actor-1",
      });
      expect(meta(h.createSystemMessage).actorName).toBe("Minh");
    }
  );

  it("PLATFORM actor: no lookup, no name", async () => {
    const h = make();
    await h.service.post({
      communityId: ROOM,
      systemMessageType: "MEMBER_REMOVED" as never,
      metadata: { actorRole: "PLATFORM", targetUserId: "t1" },
      triggeredByUserId: "actor-1",
    });
    expect(meta(h.createSystemMessage).actorName).toBe("");
    expect(h.getUserSnapshotsMap).toHaveBeenCalledWith(["t1"], expect.anything());
  });
});

describe("mandatory System inbox types", () => {
  const types = [
    "ACCOUNT_WARNED",
    "REPORT_OUTCOME",
    "COMMUNITY_ADMIN_INACTIVE_REMINDER",
    "chat.group_leader_changed",
  ];
  it("list and count under SYSTEM", () => {
    const where = categoryWhere("SYSTEM") as { OR: { type: { in?: string[] } }[] };
    const verbatim = where.OR.flatMap((c) => c.type.in ?? []);
    for (const t of types) {
      expect(verbatim).toContain(t);
      expect(categorizeId(t)).toBe("SYSTEM");
    }
  });
});
