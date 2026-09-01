/**
 * `GET /api/chat/messages/:messageId/read-receipts` — the per-message
 * "Viewed by" sheet, across PRIVATE, GROUP and COMMUNITY.
 *
 * The rules being pinned here are the ones that are easy to regress:
 *   - sender-only (a reader must never learn who else read a message)
 *   - only members whose read WATERMARK covers this message's sequenceNumber
 *   - only the ACTIVE roster (left/removed/banned members disappear)
 *   - reciprocal read-receipt settings, both halves
 *   - a deleted message has no sheet at all
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import { invalidateAccountChatSettings } from "../../src/lib/account-chat-settings.js";
import { userGrpcClient } from "../../src/grpc/user-snapshot.client.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const MSG = "aaaaaaaaaaaaaaaaaaaaaaa1";
const PEER = "peer_user_1";
const ROOM = "room_receipts_1";
const MSG_SEQ = 5;
const READ_AT = new Date("2026-08-11T10:00:00.000Z");

const url = (conversationType: string) =>
  `/api/chat/messages/${MSG}/read-receipts?conversationType=${conversationType}&roomId=${ROOM}`;

const get = (conversationType: string) =>
  request(app).get(url(conversationType)).set(bearer(makeAccessToken()));

function setReadReceipts(readReceipts: boolean): void {
  (userGrpcClient.getChatSettings as jest.Mock).mockResolvedValue({
    autoDeleteTimer: "OFF",
    typingIndicators: true,
    readReceipts,
  });
}

/** Snapshot cache pre-seeded, so no user-service round trip is attempted. */
function seedSnapshots(userIds: string[]): void {
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(
    new Map(
      userIds.map((id) => [
        id,
        {
          userId: id,
          displayName: `Name ${id}`,
          avatar: `https://media.test/${id}.png`,
          memberId: `handle_${id}`,
          isOnline: true,
        },
      ])
    )
  );
}

// --- per-conversation-type fixtures -----------------------------------------

function givenPrivate(opts?: {
  peerReadSeq?: number;
  senderId?: string;
}): void {
  mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
    roomId: ROOM,
    participants: [TEST_USER_ID, PEER],
    lastReadMessageIdByUser: { [PEER]: "peer_cursor" },
    lastReadAtByUser: { [PEER]: READ_AT.toISOString() },
  });
  mocks.privateMessageRepo.findMessageMeta.mockResolvedValue({
    id: MSG,
    roomId: ROOM,
    senderId: opts?.senderId ?? TEST_USER_ID,
    sequenceNumber: MSG_SEQ,
    createdAt: new Date("2026-08-11T09:00:00.000Z"),
    isDeleted: false,
    deletedFor: {},
  });
  mocks.privateMessageRepo.findById.mockResolvedValue({
    id: "peer_cursor",
    sequenceNumber: opts?.peerReadSeq ?? MSG_SEQ,
  });
}

function givenGroup(opts?: { senderId?: string }): void {
  mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
    roomId: ROOM,
    userId: TEST_USER_ID,
    status: "ACTIVE",
    role: "MEMBER",
  });
  mocks.groupMessageRepo.findById.mockResolvedValue({
    id: MSG,
    roomId: ROOM,
    senderId: opts?.senderId ?? TEST_USER_ID,
    sequenceNumber: MSG_SEQ,
    createdAt: new Date("2026-08-11T09:00:00.000Z"),
    isDeleted: false,
    deletedForUserIds: [],
  });
  // Only ACTIVE members are returned by the repo at all — "u_behind" has read
  // less far than this message, so it is the seq comparison being exercised.
  mocks.groupMemberRepo.findActiveMembers.mockResolvedValue([
    { userId: TEST_USER_ID, lastReadMessageId: "c_self", lastReadAt: READ_AT },
    { userId: "u_read", lastReadMessageId: "c_read", lastReadAt: READ_AT },
    { userId: "u_behind", lastReadMessageId: "c_behind", lastReadAt: READ_AT },
    { userId: "u_never", lastReadMessageId: null, lastReadAt: null },
  ]);
  mocks.groupMessageRepo.findManyByIds.mockResolvedValue([
    { id: "c_read", sequenceNumber: MSG_SEQ + 2 },
    { id: "c_behind", sequenceNumber: MSG_SEQ - 1 },
  ]);
}

function givenCommunity(opts?: { sentBy?: string }): void {
  mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
    roomId: ROOM,
    userId: TEST_USER_ID,
    status: "active",
    role: "member",
  });
  mocks.generalRoomMessageRepo.findById.mockResolvedValue({
    id: MSG,
    roomId: ROOM,
    sentBy: opts?.sentBy ?? TEST_USER_ID,
    sequenceNumber: MSG_SEQ,
    createdAt: new Date("2026-08-11T09:00:00.000Z"),
    deletedForAll: false,
  });
  mocks.roomMemberRepo.findActiveReadersSince.mockResolvedValue([
    { userId: "u_read", lastReadMessageId: "c_read", lastReadAt: READ_AT },
    { userId: "u_behind", lastReadMessageId: "c_behind", lastReadAt: READ_AT },
  ]);
  mocks.generalRoomMessageRepo.findSequencesByIds.mockResolvedValue([
    { id: "c_read", sequenceNumber: MSG_SEQ },
    { id: "c_behind", sequenceNumber: MSG_SEQ - 1 },
  ]);
}

beforeEach(() => {
  ({ app, mocks } = buildApp());
  invalidateAccountChatSettings();
  setReadReceipts(true);
  seedSnapshots([PEER, "u_read", "u_behind", "u_never"]);
});

describe("PRIVATE", () => {
  it("returns the peer once their watermark reaches the message", async () => {
    givenPrivate({ peerReadSeq: MSG_SEQ });
    const res = await get("PRIVATE");

    expect(res.status).toBe(200);
    expect(res.body.data.totalReadCount).toBe(1);
    expect(res.body.data.hasMore).toBe(false);
    expect(res.body.data.users[0]).toMatchObject({
      userId: PEER,
      fullName: `Name ${PEER}`,
      username: `handle_${PEER}`,
      readAt: READ_AT.getTime(),
    });
  });

  it("returns nobody while the peer's watermark is still behind", async () => {
    givenPrivate({ peerReadSeq: MSG_SEQ - 1 });
    const res = await get("PRIVATE");

    expect(res.status).toBe(200);
    expect(res.body.data.totalReadCount).toBe(0);
    expect(res.body.data.users).toEqual([]);
  });

  it("signs the reader's stored avatar objectKey instead of shipping the raw key", async () => {
    givenPrivate({ peerReadSeq: MSG_SEQ });
    mocks.cacheRepo.getUserSnapshots.mockResolvedValue(
      new Map([
        [
          PEER,
          {
            userId: PEER,
            displayName: `Name ${PEER}`,
            avatar: "avatars/peer_user_1.png",
            memberId: `handle_${PEER}`,
            isOnline: true,
          },
        ],
      ])
    );
    const res = await get("PRIVATE");

    expect(res.status).toBe(200);
    expect(res.body.data.users[0].avatar).toMatch(/^https:\/\/media\.test\//);
  });

  it("403s for anyone but the sender", async () => {
    givenPrivate({ senderId: PEER });
    const res = await get("PRIVATE");

    expect(res.status).toBe(403);
  });

  it("410s for a deleted message — no sheet", async () => {
    givenPrivate();
    mocks.privateMessageRepo.findMessageMeta.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      senderId: TEST_USER_ID,
      sequenceNumber: MSG_SEQ,
      createdAt: new Date(),
      isDeleted: true,
      deletedFor: {},
    });
    const res = await get("PRIVATE");

    expect(res.status).toBe(410);
  });
});

describe("GROUP", () => {
  it("lists only members whose watermark covers the message", async () => {
    givenGroup();
    const res = await get("GROUP");

    expect(res.status).toBe(200);
    expect(
      res.body.data.users.map((u: { userId: string }) => u.userId)
    ).toEqual(["u_read"]);
  });

  it("403s for a member who did not send the message", async () => {
    givenGroup({ senderId: "someone_else" });
    const res = await get("GROUP");

    expect(res.status).toBe(403);
  });

  it("403s when the caller has read receipts switched off", async () => {
    givenGroup();
    setReadReceipts(false);
    const res = await get("GROUP");

    expect(res.status).toBe(403);
  });

  it("drops a reader who gives no read receipts", async () => {
    givenGroup();
    (userGrpcClient.getChatSettings as jest.Mock).mockImplementation(
      async (userId: string) => ({
        autoDeleteTimer: "OFF",
        typingIndicators: true,
        readReceipts: userId !== "u_read",
      })
    );
    const res = await get("GROUP");

    expect(res.status).toBe(200);
    expect(res.body.data.totalReadCount).toBe(0);
  });
});

describe("COMMUNITY", () => {
  it("lists readers without ever loading the full roster", async () => {
    givenCommunity();
    const res = await get("COMMUNITY");

    expect(res.status).toBe(200);
    expect(
      res.body.data.users.map((u: { userId: string }) => u.userId)
    ).toEqual(["u_read"]);
    // The 5 000-member rule: candidates come from the read-pointer query, never
    // from "every member of this community".
    expect(mocks.roomMemberRepo.findActiveReadersSince).toHaveBeenCalledWith(
      ROOM,
      new Date("2026-08-11T09:00:00.000Z")
    );
    expect(mocks.roomMemberRepo.findActiveByRoom).not.toHaveBeenCalled();
  });

  it("403s for anyone but the sender", async () => {
    givenCommunity({ sentBy: "someone_else" });
    const res = await get("COMMUNITY");

    expect(res.status).toBe(403);
  });

  it("410s for a message deleted for everyone", async () => {
    givenCommunity();
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TEST_USER_ID,
      sequenceNumber: MSG_SEQ,
      createdAt: new Date(),
      deletedForAll: true,
    });
    const res = await get("COMMUNITY");

    expect(res.status).toBe(410);
  });
});
