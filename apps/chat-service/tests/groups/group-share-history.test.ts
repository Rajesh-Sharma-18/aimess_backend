/**
 * Add-member "share previous messages" choice: `shareHistory` on
 * POST /api/chat/group-members/add stamps GroupMember.historyFrom (epoch 0 =
 * shared, null = only new), which getGroupVisibilityCutoff reads instead of
 * joinedAt. Clear/Delete Conversation still apply on top.
 *
 *   npx jest group-share-history
 */
import request from "supertest";

import { GroupMessageService } from "../../src/services/group-message.service.js";
import { getGroupVisibilityCutoff } from "../../src/lib/deletion-cutoff.js";
import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

const ROOM = "grp_room_share";
const SHARED = new Date(0);
const JOINED_AT = new Date("2026-01-10T10:00:00.000Z");
const BEFORE_JOIN = new Date("2026-01-10T09:00:00.000Z");
const CLEARED_AT = new Date("2026-01-05T00:00:00.000Z");
const MSG_ID = "m".repeat(24);

const flush = () => new Promise((r) => setImmediate(r));

describe("getGroupVisibilityCutoff with historyFrom", () => {
  it("shared history drops the join floor", () => {
    expect(
      getGroupVisibilityCutoff({ joinedAt: JOINED_AT, historyFrom: SHARED })
    ).toBeUndefined();
  });

  it("shared history still honours the member's own clear", () => {
    expect(
      getGroupVisibilityCutoff({
        joinedAt: JOINED_AT,
        historyFrom: SHARED,
        clearChatAt: CLEARED_AT,
      })
    ).toEqual(CLEARED_AT);
  });

  it("existing rows (historyFrom unset/null) keep the joinedAt floor", () => {
    expect(getGroupVisibilityCutoff({ joinedAt: JOINED_AT })).toEqual(JOINED_AT);
    expect(
      getGroupVisibilityCutoff({ joinedAt: JOINED_AT, historyFrom: null })
    ).toEqual(JOINED_AT);
  });
});

describe("POST /api/chat/group-members/add — shareHistory", () => {
  let app: import("express").Express;
  let mocks: BuiltMocks;

  beforeEach(() => {
    ({ app, mocks } = buildApp());
    mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
    mocks.groupRoomRepo.findActiveByRoomId.mockResolvedValue({
      roomId: ROOM,
      name: "Squad",
      memberCount: 2,
      memberLimit: 256,
    });
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue(null);
    mocks.groupMemberRepo.upsert.mockImplementation(
      async (roomId: string, userId: string, data: Record<string, unknown>) => ({
        roomId,
        userId,
        ...data,
      })
    );
    mocks.groupRoomRepo.allocateSequence.mockResolvedValue(7);
    mocks.groupMessageRepo.create.mockImplementation(async (row: any) => ({
      ...row,
      id: "sys-msg-1",
      createdAt: new Date(),
      revision: 1,
    }));
  });

  const add = (body: Record<string, unknown>) =>
    request(app)
      .post("/api/chat/group-members/add")
      .set(bearer(makeAccessToken()))
      .send({ roomId: ROOM, ...body });

  const upsertData = () =>
    mocks.groupMemberRepo.upsert.mock.calls.map(
      (c: unknown[]) => c[2] as Record<string, any>
    );

  const groupAdded = () =>
    mocks.redis.publish.mock.calls
      .map(([, raw]: [string, string]) => JSON.parse(raw))
      .filter((p: { event: string }) => p.event === "group:added");

  it("defaults to only-new (historyFrom null) and announces historyFrom = joinedAt ms", async () => {
    const res = await add({ userId: "user-b" });
    expect(res.status).toBe(201);
    expect(upsertData()[0]!.historyFrom).toBeNull();
    await flush();
    const [evt] = groupAdded();
    expect(evt.data.historyFrom).toBe(
      new Date(upsertData()[0]!.joinedAt).getTime()
    );
  });

  it("single add with shareHistory=true stamps epoch 0 and announces historyFrom 0", async () => {
    const res = await add({ userId: "user-b", shareHistory: true });
    expect(res.status).toBe(201);
    expect(upsertData()[0]!.historyFrom).toEqual(SHARED);
    await flush();
    expect(groupAdded()[0].data.historyFrom).toBe(0);
  });

  it("batch applies ONE choice to every added member", async () => {
    const res = await add({
      userIds: ["user-b", "user-c", "user-d"],
      shareHistory: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.added).toHaveLength(3);
    expect(upsertData().map((d) => d.historyFrom)).toEqual([
      SHARED,
      SHARED,
      SHARED,
    ]);
    await flush();
    expect(groupAdded().map((p: any) => p.data.historyFrom)).toEqual([0, 0, 0]);
  });

  it("rejects a non-boolean shareHistory", async () => {
    const res = await add({ userId: "user-b", shareHistory: "yes" });
    expect(res.status).toBe(400);
  });

  it.each(["KICKED", "LEFT"])(
    "re-add after %s with share=true resets stale clear/read state and sees full history",
    async (status) => {
      const existing = {
        roomId: ROOM,
        userId: "user-b",
        status,
        joinedAt: new Date("2025-12-01T00:00:00.000Z"),
        clearChatAt: CLEARED_AT,
        clearedAt: CLEARED_AT,
        lastReadMessageId: MSG_ID,
        unreadCount: 9,
      };
      mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue(existing);

      const res = await add({ userId: "user-b", shareHistory: true });
      expect(res.status).toBe(201);
      const data = upsertData()[0]!;
      expect(data).toMatchObject({
        historyFrom: SHARED,
        clearedAt: null,
        clearChatAt: null,
        lastReadMessageId: null,
        lastReadAt: null,
        receiptReadMessageId: null,
        receiptReadAt: null,
        unreadCount: 0,
        dismissedAt: { unset: true },
      });
      const { dismissedAt: _d, ...row } = { ...existing, ...data };
      expect(getGroupVisibilityCutoff(row)).toBeUndefined();
    }
  );

  it("retry for an already-ACTIVE member is skipped and never rewrites historyFrom", async () => {
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
      userId: "user-b",
      status: "ACTIVE",
      historyFrom: null,
    });
    const res = await add({ userIds: ["user-b"], shareHistory: true });
    expect(res.status).toBe(201);
    expect(res.body.data.skipped).toEqual([
      { userId: "user-b", reason: "CHAT_ALREADY_MEMBER" },
    ]);
    expect(mocks.groupMemberRepo.upsert).not.toHaveBeenCalled();
  });

  it("invite-link join stays only-new", async () => {
    const link = {
      token: "tok-1234567890",
      roomId: ROOM,
      createdBy: "44444444-4444-4444-8444-444444444444",
      status: "ACTIVE",
      expiresAt: null,
      maxUses: null,
      usedCount: 0,
      shareName: "",
    };
    mocks.groupInviteLinkRepo.findByToken.mockResolvedValue(link);
    mocks.groupInviteLinkRepo.findActiveByToken.mockResolvedValue(link);
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/chat/invite-links/join")
      .set(bearer(makeAccessToken()))
      .send({ token: link.token, shareHistory: true });
    expect(res.status).toBeLessThan(300);
    expect(upsertData()[0]!.historyFrom).toBeNull();
  });
});

describe("read paths follow the member's history choice", () => {
  const preJoin = {
    id: MSG_ID,
    roomId: ROOM,
    sequenceNumber: 3,
    createdAt: BEFORE_JOIN,
    isDeleted: false,
    deletedForUserIds: [],
    senderId: "usr_old",
    messageType: "TEXT",
    content: { text: "old" },
    reactions: {},
    revision: 1,
  };

  function build(shared: boolean) {
    const member = {
      status: "ACTIVE",
      role: "MEMBER",
      userId: TEST_USER_ID,
      joinedAt: JOINED_AT,
      historyFrom: shared ? SHARED : null,
      clearedAt: null,
      clearChatAt: null,
    };
    const messageRepo = {
      findById: jest.fn().mockResolvedValue(preJoin),
      findByRoomIdSeq: jest.fn().mockResolvedValue([]),
      findAroundSeq: jest.fn().mockResolvedValue([]),
      searchByText: jest.fn().mockResolvedValue({
        messages: [],
        scores: new Map(),
        hasMore: false,
        nextCursor: null,
      }),
      listMedia: jest.fn().mockResolvedValue([]),
      findAfterSeq: jest.fn().mockResolvedValue([preJoin]),
    };
    const memberRepo = {
      findByRoomAndUser: jest.fn().mockResolvedValue(member),
      findActiveByRoomAndUser: jest.fn().mockResolvedValue(member),
      findActiveMembers: jest.fn().mockResolvedValue([]),
    };
    const roomRepo = {
      findByRoomId: jest.fn().mockResolvedValue({ roomId: ROOM, status: "ACTIVE" }),
      getRoomRevision: jest.fn().mockResolvedValue(1),
    };
    const service = new GroupMessageService(
      messageRepo as never,
      roomRepo as never,
      memberRepo as never,
      {} as never,
      {} as never
    );
    return { service, messageRepo };
  }

  const base = { roomId: ROOM, userId: TEST_USER_ID };

  it("shared: seq history, search and media run with no join cutoff", async () => {
    const { service, messageRepo } = build(true);
    await service.getMessagesSeq({ ...base, direction: "before", seq: null, limit: 20 });
    await service.searchMessages({ ...base, query: "old", limit: 20 });
    await service.listMedia({ ...base, limit: 20 });
    for (const fn of [
      messageRepo.findByRoomIdSeq,
      messageRepo.searchByText,
      messageRepo.listMedia,
    ]) {
      expect(fn.mock.calls[0][0].cutoff).toBeUndefined();
    }
  });

  it("only-new: the same reads are bounded by joinedAt", async () => {
    const { service, messageRepo } = build(false);
    await service.getMessagesSeq({ ...base, direction: "before", seq: null, limit: 20 });
    await service.searchMessages({ ...base, query: "old", limit: 20 });
    await service.listMedia({ ...base, limit: 20 });
    for (const fn of [
      messageRepo.findByRoomIdSeq,
      messageRepo.searchByText,
      messageRepo.listMedia,
    ]) {
      expect(fn.mock.calls[0][0].cutoff).toEqual(JOINED_AT);
    }
  });

  it("shared: around a pre-join message builds the window", async () => {
    const { service, messageRepo } = build(true);
    await service.getMessagesAround({ ...base, messageId: MSG_ID, limit: 30 });
    expect(messageRepo.findAroundSeq).toHaveBeenCalled();
  });

  it("catchup delivers pre-join rows only when shared", async () => {
    const run = (shared: boolean) =>
      build(shared).service.catchup({ ...base, sinceSeq: 0, limit: 50 });
    expect((await run(true)).events).toHaveLength(1);
    expect((await run(false)).events).toHaveLength(0);
  });

  describe("only-new: a pre-join id answers CHAT_MESSAGE_BEFORE_JOIN", () => {
    const BEFORE = { messageKey: "CHAT_MESSAGE_BEFORE_JOIN" };
    it("around", async () => {
      await expect(
        build(false).service.getMessagesAround({ ...base, messageId: MSG_ID, limit: 30 })
      ).rejects.toMatchObject(BEFORE);
    });
    it("react", async () => {
      await expect(
        build(false).service.react(MSG_ID, TEST_USER_ID, "👍")
      ).rejects.toMatchObject(BEFORE);
    });
    it("setReaction", async () => {
      await expect(
        build(false).service.setReaction(MSG_ID, TEST_USER_ID, "👍")
      ).rejects.toMatchObject(BEFORE);
    });
    it("viewed-by", async () => {
      await expect(
        build(false).service.getMessageReadBy({
          roomId: ROOM,
          messageId: MSG_ID,
          requesterId: TEST_USER_ID,
        })
      ).rejects.toMatchObject(BEFORE);
    });
    it("reactions", async () => {
      const { service } = build(false);
      const q = { roomId: ROOM, messageId: MSG_ID, requesterId: TEST_USER_ID };
      await expect(service.getMessageReactions(q)).rejects.toMatchObject(BEFORE);
      await expect(service.getMessageReactionsPage(q)).rejects.toMatchObject(BEFORE);
    });
    it("report", async () => {
      await expect(
        build(false).service.report({
          messageId: MSG_ID,
          reporterId: TEST_USER_ID,
          reportReason: "SPAM",
        })
      ).rejects.toMatchObject(BEFORE);
    });
    it("delete-for-me", async () => {
      await expect(
        build(false).service.deleteForMe(MSG_ID, TEST_USER_ID, ROOM)
      ).rejects.toMatchObject(BEFORE);
    });
  });
});
