/**
 * "Clear conversation" must bump the LIST, not just the open chat.
 *
 * Clearing leaves the row in the list (it is not "delete conversation") but
 * empties it for that one user, so its effective lastActivity becomes 0 and it
 * has to fall to the bottom. The clear paths only ever emitted `conv:cleared`,
 * which is a chat-window event: every other device of the same user — and any
 * client that drives its list off `conv:updated` — kept the cleared chat at the
 * top, with its old preview, until a hard reload.
 *
 * Self-only in both cases: a clear is one-sided and must never touch the peer's
 * or the other members' view. And `countInUnread: false`, because an emptied row
 * is not a new message and must not raise a badge.
 */
jest.mock("../../src/events/publish-conv-updated.js", () => ({
  publishConvUpdatedSafe: jest.fn(),
  publishCommunityUpdatedSafe: jest.fn(),
}));

import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import { publishConvUpdatedSafe } from "../../src/events/publish-conv-updated.js";

const bump = publishConvUpdatedSafe as jest.Mock;

const ROOM = "prv_1";
const GROUP = "grp_1";
const PEER = "peer-1";

let app: import("express").Express;
let mocks: BuiltMocks;

beforeEach(() => {
  jest.clearAllMocks();
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

function clearedEvents(userId: string, event: string) {
  return (mocks.redis.publish as jest.Mock).mock.calls.filter(
    ([channel, payload]: [string, string]) =>
      channel === `user:${userId}` && String(payload).includes(`"${event}"`)
  );
}

describe("POST /private/rooms/:roomId/clear", () => {
  it("emits an EMPTY self-only conv:updated alongside conv:cleared", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, PEER],
    });
    mocks.privateRoomRepo.setClearFor.mockResolvedValue(undefined);

    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/clear`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(clearedEvents(TEST_USER_ID, "conv:cleared")).toHaveLength(1);
    expect(bump).toHaveBeenCalledTimes(1);
    expect(bump).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "PRIVATE",
        roomId: ROOM,
        recipientIds: [TEST_USER_ID], // never the peer
        lastMessageId: "",
        lastMessageAt: 0,
        countInUnread: false,
      })
    );
  });
});

describe("POST /groups/:roomId/clear", () => {
  it("emits an EMPTY conv:updated to the clearing member only", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      roomId: GROUP,
      userId: TEST_USER_ID,
      status: "ACTIVE",
    });
    mocks.groupMemberRepo.setClearChatAt.mockResolvedValue(undefined);

    const res = await request(app)
      .post(`/api/chat/groups/${GROUP}/clear`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(bump).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "GROUP",
        roomId: GROUP,
        recipientIds: [TEST_USER_ID],
        lastMessageAt: 0,
        countInUnread: false,
      })
    );
  });
});
