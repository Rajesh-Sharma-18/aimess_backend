/**
 * Contract §8: a REMOVED (KICKED) group member keeps a read-only chat up to and
 * including the removal line; every write is 403 CHAT_NOT_GROUP_MEMBER; the
 * inbox row says membershipStatus "REMOVED" + removedAt with no unread.
 */
import request from "supertest";
import { ForbiddenError, NotFoundError } from "@aimess/errors";

import { GroupMessageService } from "../../src/services/group-message.service.js";
import { assertGroupMember } from "../../src/lib/access-guard.js";
import {
  buildApp,
  mockGroupMemberships,
  type BuiltMocks,
} from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

const ROOM = "grp_removed";
const ME = "usr_me";
const KICKED_AT = new Date("2026-10-01T10:00:00.000Z");
const BEFORE = new Date("2026-10-01T09:59:00.000Z");
const AFTER = new Date("2026-10-01T10:05:00.000Z");
const kicked = { roomId: ROOM, userId: ME, status: "KICKED", kickedAt: KICKED_AT, role: "MEMBER" };

const msg = (id: string, createdAt: Date, seq: number) => ({
  id,
  roomId: ROOM,
  senderId: "usr_other",
  sequenceNumber: seq,
  createdAt,
  isDeleted: false,
  deletedForUserIds: [],
  messageType: "TEXT",
});

function buildService(member: Record<string, unknown> | null = kicked) {
  const messageRepo = {
    findById: jest.fn(async (id: string) =>
      id === "m_after" ? msg("m_after", AFTER, 9) : msg("m_before", BEFORE, 7)
    ),
    findAfterSeq: jest.fn(async () => [
      msg("m_before", BEFORE, 7),
      msg("m_after", AFTER, 9),
    ]),
    findByRoomIdRevisionSince: jest.fn(async () => ({
      messages: [],
      hasMore: false,
      nextRevision: null,
    })),
    listMedia: jest.fn(async () => []),
    deleteForMe: jest.fn(async (id: string) => ({ id })),
  };
  const roomRepo = {
    findByRoomId: jest.fn(async () => ({ roomId: ROOM, status: "ACTIVE" })),
    getRoomRevision: jest.fn(async () => 1),
  };
  const memberRepo = {
    findActiveByRoomAndUser: jest.fn(async () => null),
    findByRoomAndUser: jest.fn(async () => member),
    decrementUnreadForMessage: jest.fn(async () => undefined),
  };
  const service = new GroupMessageService(
    messageRepo as never,
    roomRepo as never,
    memberRepo as never,
    {} as never,
    {} as never
  );
  return { service, messageRepo, memberRepo };
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => "RESOLVED",
    (e: { message?: string; code?: string }) => e.code ?? e.message
  );

describe("removed member — writes are 403 CHAT_NOT_GROUP_MEMBER", () => {
  it("send", async () => {
    const { service } = buildService();
    const err = await service
      .sendMessage({
        roomId: ROOM,
        senderId: ME,
        senderName: "Me",
        senderAvatar: "",
        content: { text: "hi" },
        messageType: "TEXT",
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as Error).message).toBe("CHAT_NOT_GROUP_MEMBER");
  });

  it("react (write boundary), invite/pin/admin actions (assertGroupMember)", async () => {
    const { service, memberRepo } = buildService();
    await expect(code(service.assertCanWrite(ROOM, ME))).resolves.toBe(
      "CHAT_NOT_GROUP_MEMBER"
    );
    await expect(
      code(assertGroupMember(memberRepo as never, ROOM, ME, { roles: ["ADMIN"] }))
    ).resolves.toBe("CHAT_NOT_GROUP_MEMBER");
  });

  it("edit and delete-for-everyone", async () => {
    const { service } = buildService();
    await expect(
      code(
        service.editMessage({
          messageId: "m_before",
          userId: ME,
          content: { text: "x" },
        })
      )
    ).resolves.toBe("CHAT_NOT_GROUP_MEMBER");
    await expect(
      code(service.deleteMessage("m_before", ME, ROOM))
    ).resolves.toBe("CHAT_NOT_GROUP_MEMBER");
  });

  it("mark-read past the removal line is refused; up to it is a silent no-op", async () => {
    const { service } = buildService();
    await expect(
      code(service.markReadUpTo({ roomId: ROOM, userId: ME, upToMessageId: "64b000000000000000000002" }))
    ).resolves.toBe("RESOLVED");
    const { service: s2, messageRepo } = buildService();
    messageRepo.findById.mockResolvedValue(msg("m_after", AFTER, 9));
    await expect(
      code(s2.markReadUpTo({ roomId: ROOM, userId: ME, upToMessageId: "64b000000000000000000001" }))
    ).resolves.toBe("CHAT_NOT_GROUP_MEMBER");
  });

  it("NEGATIVE: a never-member still gets the old CHAT_NOT_A_MEMBER", async () => {
    const { service } = buildService(null);
    await expect(code(service.assertCanWrite(ROOM, ME))).resolves.toBe(
      "CHAT_NOT_A_MEMBER"
    );
  });
});

describe("removed member — personal actions stay allowed", () => {
  it("delete-for-me inside the readable range works; past the removal line is 404", async () => {
    const { service, messageRepo } = buildService();
    await expect(service.deleteForMe("m_before", ME, ROOM)).resolves.toEqual({ id: "m_before" });
    expect(messageRepo.deleteForMe).toHaveBeenCalledWith("m_before", ME);
    await expect(service.deleteForMe("m_after", ME, ROOM)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("NEGATIVE: a voluntary leaver cannot delete-for-me", async () => {
    const { service } = buildService({ status: "LEFT", leftAt: KICKED_AT });
    await expect(code(service.deleteForMe("m_before", ME, ROOM))).resolves.toBe("CHAT_NOT_A_MEMBER");
  });
});

describe("removed member — reads stop at the removal line", () => {
  it("catch-up never delivers a message posted after removal", async () => {
    const { service } = buildService();
    const res = await service.catchup({ roomId: ROOM, userId: ME, sinceSeq: 0, limit: 10 });
    expect(res.authorized).toBe(true);
    expect(res.events.map((m) => m.id)).toEqual(["m_before"]);
    expect(res.hasMore).toBe(false);
  });

  it("changes feed, media and context carry / enforce the cutoff", async () => {
    const { service, messageRepo } = buildService();
    await service.getChanges({ roomId: ROOM, userId: ME, sinceRevision: 0, limit: 10 });
    expect(messageRepo.findByRoomIdRevisionSince).toHaveBeenCalledWith(
      expect.objectContaining({ readCutoffBefore: KICKED_AT })
    );
    await service.listMedia({ roomId: ROOM, userId: ME, limit: 10 });
    expect(messageRepo.listMedia).toHaveBeenCalledWith(
      expect.objectContaining({ readCutoffBefore: KICKED_AT })
    );
    await expect(service.getMessageContext(ROOM, "m_before", ME)).resolves.toMatchObject({ id: "m_before" });
    await expect(service.getMessageContext(ROOM, "m_after", ME)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("NEGATIVE: a voluntary leaver still reads nothing", async () => {
    const { service } = buildService({ status: "LEFT", leftAt: KICKED_AT });
    const res = await service.catchup({ roomId: ROOM, userId: ME, sinceSeq: 0, limit: 10 });
    expect(res.authorized).toBe(false);
    await expect(
      service.listMedia({ roomId: ROOM, userId: ME, limit: 10 })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("removed member — inbox row and roster (HTTP)", () => {
  let app: import("express").Express;
  let mocks: BuiltMocks;

  beforeEach(() => {
    ({ app, mocks } = buildApp());
    mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  });

  it("lists the group as REMOVED with removedAt, no unread, previewing only up to the removal line", async () => {
    mocks.privateRoomRepo.getInboxConversations.mockResolvedValue([]);
    mocks.privateRoomRepo.countConversations.mockResolvedValue(0);
    mockGroupMemberships(mocks, [
      { roomId: ROOM, role: "MEMBER", status: "KICKED", kickedAt: KICKED_AT, unreadCount: 4, notificationSettings: {} },
    ]);
    mocks.groupRoomRepo.getInboxGroups.mockResolvedValue([
      {
        roomId: ROOM,
        name: "Devs",
        avatar: "",
        memberCount: 3,
        lastMessageAt: AFTER,
        lastMessageId: "m_after",
        lastMessagePreview: { text: "posted after removal", senderId: "usr_other", messageType: "TEXT", createdAt: AFTER },
        pinnedCount: 0,
      },
    ]);
    mocks.groupRoomRepo.countUserGroups.mockResolvedValue(1);
    mocks.groupRoomRepo.findLastMessageAtForRooms.mockResolvedValue([{ roomId: ROOM, lastMessageAt: AFTER }]);
    mocks.groupMessageRepo.filterHiddenFromUser.mockResolvedValue(new Set());
    mocks.groupMessageRepo.findByRoomIdWithTime.mockResolvedValue([
      {
        id: "m_line",
        roomId: ROOM,
        senderId: "",
        messageType: "SYSTEM",
        systemEvent: "MEMBER_REMOVED",
        systemData: { actorId: "usr_an", targetUserId: TEST_USER_ID },
        content: { text: "An removed you" },
        createdAt: KICKED_AT,
      },
    ]);

    const res = await request(app).get("/api/chat/inbox").set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    const row = res.body.data.data[0];
    expect(row).toMatchObject({
      membershipStatus: "REMOVED",
      removedAt: KICKED_AT.getTime(),
      unreadCount: 0,
      isRemoved: true,
      isJoined: false,
    });
    expect(JSON.stringify(row)).not.toContain("posted after removal");
    expect(row.lastActivity.dateTime).toBe(KICKED_AT.getTime());
    expect(mocks.groupMessageRepo.findByRoomIdWithTime).toHaveBeenCalledWith(
      ROOM,
      new Date(KICKED_AT.getTime() + 1).toISOString(),
      1,
      TEST_USER_ID
    );
  });

  it("clear chat is allowed for a removed member", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({ ...kicked, userId: TEST_USER_ID });
    mocks.groupMessageRepo.hasClearableAfter.mockResolvedValue(true);
    mocks.groupMemberRepo.setClearChatAt.mockResolvedValue(new Date());
    mocks.groupRoomRepo.findByRoomId.mockResolvedValue({ roomId: ROOM, status: "ACTIVE" });
    const res = await request(app)
      .post(`/api/chat/groups/rooms/${ROOM}/clear`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(200);
    expect(mocks.groupMemberRepo.setClearChatAt).toHaveBeenCalledWith(ROOM, TEST_USER_ID);
  });

  it("NEGATIVE: the live roster stays closed to a removed member", async () => {
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({ ...kicked, userId: TEST_USER_ID });
    const res = await request(app)
      .get(`/api/chat/group-members/${ROOM}`)
      .set(bearer(makeAccessToken()));
    expect(res.status).toBe(403);
    expect(res.body.error?.code ?? res.body.code).toBe("CHAT_NOT_GROUP_MEMBER");
  });
});
