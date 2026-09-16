/**
 * Group mention inbox rows are retracted when their mention stops standing:
 * delete-for-everyone, or an edit that drops the mention. GroupMessageService
 * decides WHO (individual ∪ @all audience); notifications-service removes the
 * rows. The publisher is mocked so assertions read its params directly.
 */
jest.mock("../../src/events/publish-message-sent.js", () => ({
  ...jest.requireActual("../../src/events/publish-message-sent.js"),
  publishMessageSentSafe: jest.fn(),
  publishMentionRetractedSafe: jest.fn(),
}));
jest.mock("../../src/middleware/rate-limit.js", () => ({
  ...jest.requireActual("../../src/middleware/rate-limit.js"),
  assertMentionAllAllowed: jest.fn(async () => undefined),
}));

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { TEST_USER_ID } from "../helpers/auth.js";
import { publishMentionRetractedSafe } from "../../src/events/publish-message-sent.js";

const retractMock = publishMentionRetractedSafe as jest.Mock;

let mocks: BuiltMocks;

const ROOM = "grp_room_retract";
const MSG = "g1";
const HANDLES: Record<string, string> = { u_kristi: "kristi", u_bob: "bob" };

const user = (userId: string, text: string) => {
  const token = `@${HANDLES[userId]}`;
  return {
    type: "USER",
    userId,
    username: HANDLES[userId],
    offset: text.indexOf(token),
    length: token.length,
  };
};
const all = (text: string) => ({
  type: "ALL",
  offset: text.indexOf("@all"),
  length: 4,
});

const row = (content: Record<string, unknown>) => ({
  id: MSG,
  roomId: ROOM,
  senderId: TEST_USER_ID,
  senderName: "Me",
  senderAvatar: "",
  clientMessageId: "c-g1",
  messageType: "TEXT",
  isDeleted: false,
  createdAt: new Date(Date.now() - 1000),
  content,
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

const retractedIds = (): string[] =>
  [
    ...new Set(
      (retractMock.mock.calls[0]![0] as { userIds: string[] }).userIds
    ),
  ].sort();

beforeEach(() => {
  retractMock.mockClear();
  ({ mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockImplementation(
    async () =>
      new Map([
        ...Object.entries(HANDLES).map(
          ([userId, memberId]) =>
            [userId, { userId, memberId, isDeletedUser: false }] as [
              string,
              Record<string, unknown>,
            ]
        ),
        [
          "u_carol",
          { userId: "u_carol", memberId: "carol", isDeletedUser: false },
        ],
        ["u_gone", { userId: "u_gone", memberId: "", isDeletedUser: true }],
      ])
  );
  mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
    roomId: ROOM,
    userId: TEST_USER_ID,
    status: "ACTIVE",
    role: "MEMBER",
  });
  mocks.groupMemberRepo.findActiveUserIds.mockImplementation(
    async (_roomId: string, ids: string[]) => ids
  );
  mocks.groupMemberRepo.findActiveMembers.mockResolvedValue(
    [TEST_USER_ID, "u_kristi", "u_bob", "u_carol", "u_gone"].map((userId) => ({
      userId,
    }))
  );
  // Every membership row, any status: u_left / u_kicked / u_banned are no
  // longer on the active roster but may still hold an @all row.
  mocks.groupMemberRepo.findAllUserIds.mockResolvedValue([
    TEST_USER_ID,
    "u_kristi",
    "u_bob",
    "u_carol",
    "u_gone",
    "u_left",
    "u_kicked",
    "u_banned",
  ]);
  mocks.groupMessageRepo.deleteForEveryone.mockImplementation(
    async (id: string, roomId: string) => ({
      id,
      roomId,
      sequenceNumber: 7,
    })
  );
  mocks.groupMessageRepo.editMessage.mockImplementation(
    async (_id: string, _roomId: string, content: Record<string, unknown>) => ({
      ...row(content),
      editedAt: new Date(),
    })
  );
});

describe("delete for everyone", () => {
  const del = () =>
    mocks.groupMessageService.deleteMessage(MSG, TEST_USER_ID, ROOM);

  it("retracts individual mentions ∪ every membership row incl. LEFT/KICKED/BANNED (sender excluded)", async () => {
    const text = "@kristi and @all";
    mocks.groupMessageRepo.findById.mockResolvedValue(
      row({ text, mentions: [user("u_kristi", text), all(text)] })
    );
    await del();
    await flush();

    expect(retractMock).toHaveBeenCalledTimes(1);
    expect(retractMock.mock.calls[0]![0]).toMatchObject({
      messageId: MSG,
      conversationId: ROOM,
    });
    expect(retractedIds()).toEqual([
      "u_banned",
      "u_bob",
      "u_carol",
      "u_gone",
      "u_kicked",
      "u_kristi",
      "u_left",
    ]);
    expect(mocks.groupMemberRepo.findAllUserIds).toHaveBeenCalledWith(ROOM);
  });

  it("USER-only mentions retract just those users, without a roster read", async () => {
    const text = "hi @bob";
    mocks.groupMessageRepo.findById.mockResolvedValue(
      row({ text, mentions: [user("u_bob", text)] })
    );
    await del();
    await flush();

    expect(retractedIds()).toEqual(["u_bob"]);
    expect(mocks.groupMemberRepo.findActiveMembers).not.toHaveBeenCalled();
    expect(mocks.groupMemberRepo.findAllUserIds).not.toHaveBeenCalled();
  });

  it("a message without mentions publishes nothing", async () => {
    mocks.groupMessageRepo.findById.mockResolvedValue(row({ text: "plain" }));
    await del();
    await flush();

    expect(retractMock).not.toHaveBeenCalled();
  });

  it("a refused delete publishes nothing", async () => {
    const text = "hi @bob";
    mocks.groupMessageRepo.findById.mockResolvedValue({
      ...row({ text, mentions: [user("u_bob", text)] }),
      senderId: "someone-else",
    });
    await expect(del()).rejects.toThrow();
    await flush();

    expect(retractMock).not.toHaveBeenCalled();
  });
});

describe("edit", () => {
  const edit = (text: string, mentions: unknown[]) =>
    mocks.groupMessageService.editMessage({
      messageId: MSG,
      userId: TEST_USER_ID,
      content: { text, mentions },
    });

  it("removing a USER mention retracts that user", async () => {
    const before = "hi @kristi @bob";
    mocks.groupMessageRepo.findById.mockResolvedValue(
      row({
        text: before,
        mentions: [user("u_kristi", before), user("u_bob", before)],
      })
    );
    const text = "hi @bob";
    await edit(text, [user("u_bob", text)]);
    await flush();

    expect(retractedIds()).toEqual(["u_kristi"]);
  });

  it("removing @all while keeping one USER mention retracts every membership row minus that user", async () => {
    const before = "@all @kristi";
    mocks.groupMessageRepo.findById.mockResolvedValue(
      row({ text: before, mentions: [all(before), user("u_kristi", before)] })
    );
    const text = "@kristi";
    await edit(text, [user("u_kristi", text)]);
    await flush();

    expect(retractedIds()).toEqual([
      "u_banned",
      "u_bob",
      "u_carol",
      "u_gone",
      "u_kicked",
      "u_left",
    ]);
  });

  it("'@kristi @all' → '@all' hands kristi downstream as ifAllMuted only", async () => {
    const before = "@kristi @all";
    mocks.groupMessageRepo.findById.mockResolvedValue(
      row({ text: before, mentions: [user("u_kristi", before), all(before)] })
    );
    const text = "@all";
    await edit(text, [all(text)]);
    await flush();

    expect(retractMock).toHaveBeenCalledTimes(1);
    expect(retractMock.mock.calls[0]![0]).toEqual({
      messageId: MSG,
      conversationId: ROOM,
      userIds: [],
      ifAllMutedUserIds: ["u_kristi"],
    });
    expect(mocks.groupMemberRepo.findAllUserIds).not.toHaveBeenCalled();
  });

  it("an edit that keeps the same mentions retracts nobody", async () => {
    const text = "hi @kristi @all";
    mocks.groupMessageRepo.findById.mockResolvedValue(
      row({ text, mentions: [user("u_kristi", text), all(text)] })
    );
    await edit(text, [user("u_kristi", text), all(text)]);
    await flush();

    expect(retractMock).not.toHaveBeenCalled();
  });
});
