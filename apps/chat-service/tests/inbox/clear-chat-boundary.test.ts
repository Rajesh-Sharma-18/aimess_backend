/**
 * Clear Chat is a per-user history boundary, and every surface that hands out
 * historical content must respect it — for the user who cleared, and ONLY for
 * them:
 *   - Shared Media lists (private + group) read through the caller's cutoff,
 *     while the peer, who did not clear, keeps the whole gallery;
 *   - a reply quote cannot pull cleared (or another room's) content back;
 *   - a presigned download for a cleared private attachment is refused;
 *   - "is there anything left to clear" ignores the clear line itself.
 *
 *   npx jest clear-chat-boundary
 */
import request from "supertest";
import { ForbiddenError } from "@aimess/errors";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import { assertMediaWithinHistory } from "../../src/lib/media-history-guard.js";
import {
  groupHistoryLineEvent,
  privateHistoryLineEvent,
} from "../../src/lib/deletion-cutoff.js";
import { PrivateMessageRepository } from "../../src/repositories/private-message.repository.js";
import { GroupMessageRepository } from "../../src/repositories/group-message.repository.js";

const ROOM = "prv_room_1";
const OTHER_ROOM = "prv_room_2";
const GROUP = "grp_room_1";
const PEER = "peer_user_1";
const PARENT_ID = "0123456789abcdef01234567";
const CLEARED_AT = "2026-08-10T10:00:00.000Z";
const BEFORE = new Date("2026-08-10T09:00:00.000Z");
const AFTER = new Date("2026-08-10T11:00:00.000Z");

let app: import("express").Express;
let mocks: BuiltMocks;

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

const privateRoom = () => ({
  roomId: ROOM,
  participants: [TEST_USER_ID, PEER],
  // Only the caller cleared.
  clearFor: { [TEST_USER_ID]: CLEARED_AT },
});

describe("Shared Media respects the clear boundary, per user", () => {
  it("private: the clearer's media list starts after their cutoff", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(privateRoom());
    mocks.privateMessageRepo.listMedia.mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/media?type=media`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.privateMessageRepo.listMedia).toHaveBeenCalledWith(
      expect.objectContaining({ cutoff: new Date(CLEARED_AT) })
    );
  });

  it("private: the peer who did NOT clear still gets the whole gallery", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(privateRoom());
    mocks.privateMessageRepo.listMedia.mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/media?type=media`)
      .set(bearer(makeAccessToken({ userId: PEER })));

    expect(res.status).toBe(200);
    expect(mocks.privateMessageRepo.listMedia).toHaveBeenCalledWith(
      expect.objectContaining({ cutoff: undefined })
    );
  });

  it("group: the member's media list starts after their Clear Chat", async () => {
    const clearChatAt = new Date(CLEARED_AT);
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      roomId: GROUP,
      userId: TEST_USER_ID,
      status: "ACTIVE",
      joinedAt: BEFORE,
      clearChatAt,
    });
    mocks.groupMessageRepo.listMedia.mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/chat/groups/rooms/${GROUP}/media?type=media`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.groupMessageRepo.listMedia).toHaveBeenCalledWith(
      expect.objectContaining({ cutoff: clearChatAt })
    );
  });
});

describe("private reply quote cannot reach behind the boundary", () => {
  beforeEach(() => {
    mocks.userServiceClient.checkFriendship.mockResolvedValue(true);
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue(privateRoom());
    mocks.privateMessageRepo.findByClientMessageId.mockResolvedValue(null);
    mocks.privateMessageRepo.createMessage.mockImplementation(
      async (entity: Record<string, unknown>) => ({
        ...entity,
        id: "msg_1",
        createdAt: new Date(),
      })
    );
  });

  const sendReply = () =>
    request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()))
      .send({
        receiverId: PEER,
        messageType: "TEXT",
        content: { text: "re" },
        parentMessageId: PARENT_ID,
        clientMessageId: "cmid-reply",
      });

  const parent = (over: Record<string, unknown>) => ({
    id: PARENT_ID,
    roomId: ROOM,
    senderId: PEER,
    messageType: "TEXT",
    content: { text: "secret from before the clear" },
    isDeleted: false,
    createdAt: AFTER,
    ...over,
  });

  const created = () =>
    mocks.privateMessageRepo.createMessage.mock.calls[0][0] as Record<
      string,
      unknown
    >;

  it("drops the quote AND the pointer for a parent the sender cleared", async () => {
    mocks.privateMessageRepo.findById.mockResolvedValue(
      parent({ createdAt: BEFORE })
    );
    expect((await sendReply()).status).toBe(201);
    expect(created().parentMessageId).toBeNull();
    expect(created().quoteData).toBeUndefined();
  });

  it("drops a parent from ANOTHER room", async () => {
    mocks.privateMessageRepo.findById.mockResolvedValue(
      parent({ roomId: OTHER_ROOM })
    );
    expect((await sendReply()).status).toBe(201);
    expect(created().parentMessageId).toBeNull();
    expect(created().quoteData).toBeUndefined();
  });

  it("keeps a parent sent after the clear", async () => {
    mocks.privateMessageRepo.findById.mockResolvedValue(parent({}));
    expect((await sendReply()).status).toBe(201);
    expect(created().parentMessageId).toBe(PARENT_ID);
    expect(created().quoteData).toMatchObject({ messageId: PARENT_ID });
  });
});

describe("private attachment download respects the clear boundary", () => {
  const run = (cutoff: Date | undefined, createdAt: Date, carried = false) =>
    assertMediaWithinHistory({
      cutoff,
      roomId: ROOM,
      objectKey: "chat-uploads/peer/a.jpg",
      objectCreatedAtMs: createdAt.getTime(),
      probe: jest.fn().mockResolvedValue(carried),
    });

  it("refuses the clearer an object from before their cutoff", async () => {
    await expect(run(new Date(CLEARED_AT), BEFORE)).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  it("allows the peer (no cutoff) the same object", async () => {
    await expect(run(undefined, BEFORE)).resolves.toBeUndefined();
  });

  it("allows an object a post-clear message carries (forward/re-send)", async () => {
    await expect(
      run(new Date(CLEARED_AT), BEFORE, true)
    ).resolves.toBeUndefined();
  });

  it("allows anything uploaded after the clear", async () => {
    await expect(run(new Date(CLEARED_AT), AFTER)).resolves.toBeUndefined();
  });
});

describe("which history line set the cutoff", () => {
  it("private: CLEARED only when Clear Chat is the latest cutoff", () => {
    expect(privateHistoryLineEvent({ clearFor: { u: CLEARED_AT } }, "u")).toBe(
      "CONVERSATION_CLEARED"
    );
    expect(
      privateHistoryLineEvent(
        {
          clearFor: { u: CLEARED_AT },
          deletedFor: { u: AFTER.toISOString() },
        },
        "u"
      )
    ).toBeNull();
    expect(privateHistoryLineEvent({}, "u")).toBeNull();
  });

  it("group: CLEARED / DELETED / null (a join date is not a clear)", () => {
    expect(
      groupHistoryLineEvent({ joinedAt: BEFORE, clearChatAt: AFTER })
    ).toBe("CONVERSATION_CLEARED");
    expect(groupHistoryLineEvent({ joinedAt: BEFORE, clearedAt: AFTER })).toBe(
      "CONVERSATION_DELETED"
    );
    expect(
      groupHistoryLineEvent({ joinedAt: AFTER, clearChatAt: BEFORE })
    ).toBeNull();
  });
});

describe("hasClearableAfter: the clear line itself is not clearable", () => {
  it("private: excludes history lines in the query and deleted-for-me rows after it", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([
        { deletedFor: { [TEST_USER_ID]: AFTER.toISOString() } },
      ]);
    const repo = new PrivateMessageRepository(
      { privateMessage: { findMany } } as never,
      {} as never
    );

    await expect(
      repo.hasClearableAfter({
        roomId: ROOM,
        userId: TEST_USER_ID,
        cutoff: new Date(CLEARED_AT),
      })
    ).resolves.toBe(false);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          roomId: ROOM,
          createdAt: { gt: new Date(CLEARED_AT) },
          NOT: {
            messageType: "SYSTEM",
            systemEvent: {
              in: ["CONVERSATION_CLEARED", "CONVERSATION_DELETED"],
            },
          },
        },
      })
    );

    findMany.mockResolvedValue([{ deletedFor: {} }]);
    await expect(
      repo.hasClearableAfter({ roomId: ROOM, userId: TEST_USER_ID })
    ).resolves.toBe(true);
  });

  it("group: same rule on deletedForUserIds", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([{ deletedForUserIds: [TEST_USER_ID] }]);
    const repo = new GroupMessageRepository(
      { groupMessage: { findMany } } as never,
      {} as never
    );
    await expect(
      repo.hasClearableAfter({ roomId: GROUP, userId: TEST_USER_ID })
    ).resolves.toBe(false);

    findMany.mockResolvedValue([{ deletedForUserIds: ["someone-else"] }]);
    await expect(
      repo.hasClearableAfter({ roomId: GROUP, userId: TEST_USER_ID })
    ).resolves.toBe(true);
  });
});
