/** AIMESS-215 — "Message yourself": a private room whose two participants are the owner. */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import {
  assertPrivateParticipant,
  isSelfRoom,
  privateRoomPeerId,
} from "../../src/lib/access-guard.js";

const OTHER = "6dc54785-fbed-474b-a9c8-2d51ea1fe861";
const selfRoom = {
  roomId: "prv_self",
  participants: [TEST_USER_ID, TEST_USER_ID],
  lastMessageAt: null,
  lastMessage: null,
  unreadCountByUser: {},
  mutedBy: {},
  pinnedCount: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

let app: import("express").Express;
let mocks: BuiltMocks;

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  mocks.privateRoomRepo.findByParticipantsKey.mockResolvedValue(null);
});

describe("self room helpers", () => {
  it("isSelfRoom only for an owner-twice roster", () => {
    expect(isSelfRoom({ participants: [TEST_USER_ID, TEST_USER_ID] })).toBe(true);
    expect(isSelfRoom({ participants: [TEST_USER_ID, OTHER] })).toBe(false);
    expect(isSelfRoom({ participants: [] })).toBe(false);
  });

  it("the owner is the self room's peer; nobody else has one", () => {
    const room = { participants: [TEST_USER_ID, TEST_USER_ID] };
    expect(privateRoomPeerId(room, TEST_USER_ID)).toBe(TEST_USER_ID);
    expect(privateRoomPeerId(room, OTHER)).toBe("");
    expect(privateRoomPeerId({ participants: [TEST_USER_ID, OTHER] }, TEST_USER_ID)).toBe(OTHER);
  });

  it("N1: another user gets 404, not 403, on someone's self room", async () => {
    const repo = { findByRoomId: jest.fn().mockResolvedValue(selfRoom) };
    await expect(assertPrivateParticipant(repo as never, "prv_self", OTHER)).rejects.toThrow(
      "CHAT_ROOM_NOT_FOUND"
    );
    await expect(assertPrivateParticipant(repo as never, "prv_self", TEST_USER_ID)).resolves.toBe(
      selfRoom
    );
  });
});

describe("POST /api/chat/private/rooms/:me", () => {
  it("mints the self room without a friendship check", async () => {
    mocks.privateRoomRepo.create.mockResolvedValue(selfRoom);

    const res = await request(app)
      .post(`/api/chat/private/rooms/${TEST_USER_ID}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.userServiceClient.checkFriendship).not.toHaveBeenCalled();
    const created = mocks.privateRoomRepo.create.mock.calls[0][0];
    expect(created.participants).toEqual([TEST_USER_ID, TEST_USER_ID]);
    expect(created.participantsKey).toBe(`${TEST_USER_ID}:${TEST_USER_ID}`);
    expect(res.body.data.isSelf).toBe(true);
    expect(res.body.data.peerId).toBe(TEST_USER_ID);
    expect(res.body.data.unreadMessageCount).toBe(0);
    expect(res.body.data.pairState.canSendMessage).toBe(true);
  });

  it("N8: reuses the existing self room", async () => {
    mocks.privateRoomRepo.findByParticipantsKey.mockResolvedValue(selfRoom);

    const res = await request(app)
      .post(`/api/chat/private/rooms/${TEST_USER_ID}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.roomId).toBe("prv_self");
    expect(mocks.privateRoomRepo.create).not.toHaveBeenCalled();
  });
});
