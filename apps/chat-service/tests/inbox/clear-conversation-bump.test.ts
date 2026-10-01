/**
 * "Clear Chat" repaints the caller's list row IN PLACE.
 *
 * Clearing leaves the row in the list (it is not "delete conversation") and
 * empties it for that one user. The row now previews the caller's own
 * "You cleared the conversation" line, but a clear is not activity: it keeps
 * the timestamp it already sorted by (the last message the caller could see),
 * so its position does not change. A real message afterwards moves it as usual.
 *
 * The clear paths used to emit `lastMessageAt: 0` with an empty preview, which
 * dropped the row to the bottom of every device's list and left it blank.
 *
 * Self-only in both cases: a clear is one-sided and must never touch the peer's
 * or the other members' view. And `countInUnread: false`, because the repainted
 * row is not a new message and must not raise a badge.
 *
 * With nothing left to clear (only the caller's own clear line, or no messages
 * at all) the call is a no-op: no cutoff, no second line, no events.
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
/** The last message the caller could see — where the row sorts. */
const LAST_AT = new Date("2026-08-10T10:10:00.000Z");
const CUTOFF = new Date("2026-08-10T10:20:00.000Z");

let app: import("express").Express;
let mocks: BuiltMocks;

beforeEach(() => {
  jest.clearAllMocks();
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

function events(userId: string, event: string) {
  return (mocks.redis.publish as jest.Mock).mock.calls.filter(
    ([channel, payload]: [string, string]) =>
      channel === `user:${userId}` && String(payload).includes(`"${event}"`)
  );
}

function stubPrivate(clearable: boolean) {
  mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
    roomId: ROOM,
    participants: [TEST_USER_ID, PEER],
    lastMessageId: "m3",
    lastMessageAt: LAST_AT,
    lastMessage: { createdAt: LAST_AT.toISOString(), messageId: "m3" },
  });
  mocks.privateRoomRepo.setClearFor.mockResolvedValue(CUTOFF);
  mocks.privateMessageRepo.filterHiddenFromUser.mockResolvedValue(new Set());
  mocks.privateMessageRepo.hasClearableAfter.mockResolvedValue(clearable);
  mocks.privateMessageRepo.createMessage.mockImplementation(async (d: any) => ({
    id: "sys-1",
    ...d,
  }));
}

function stubGroup(clearable: boolean) {
  mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
    roomId: GROUP,
    userId: TEST_USER_ID,
    status: "ACTIVE",
  });
  mocks.groupMemberRepo.setClearChatAt.mockResolvedValue(CUTOFF);
  mocks.groupMemberRepo.findAllUserIds.mockResolvedValue([TEST_USER_ID, "m2"]);
  mocks.groupRoomRepo.findByRoomId.mockResolvedValue({
    roomId: GROUP,
    lastMessageId: "g3",
    lastMessageAt: LAST_AT,
    lastMessagePreview: { text: "hi", createdAt: LAST_AT, messageId: "g3" },
  });
  mocks.groupMessageRepo.filterHiddenFromUser.mockResolvedValue(new Set());
  mocks.groupMessageRepo.hasClearableAfter.mockResolvedValue(clearable);
  mocks.groupMessageRepo.create.mockImplementation(async (d: any) => ({
    id: "sys-g",
    ...d,
  }));
}

describe("POST /private/rooms/:roomId/clear", () => {
  it("repaints the caller's row with the clear line at its EXISTING sort time", async () => {
    stubPrivate(true);

    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/clear`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ cleared: true });
    expect(events(TEST_USER_ID, "conv:cleared")).toHaveLength(1);
    expect(bump).toHaveBeenCalledTimes(1);
    expect(bump).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "PRIVATE",
        roomId: ROOM,
        recipientIds: [TEST_USER_ID], // never the peer
        lastMessageId: "m3", // non-empty: the row is NOT emptied on the client
        lastMessageAt: LAST_AT.getTime(), // not 0, not the clear time
        preview: expect.objectContaining({
          contentType: "SYSTEM",
          systemEvent: "CONVERSATION_CLEARED",
          text: "You cleared the conversation",
        }),
        countInUnread: false,
        deleteRecalc: true,
      })
    );
    expect(events(PEER, "conv:updated")).toHaveLength(0);
  });

  it("nothing to clear: no cutoff, no line, no events, cleared:false", async () => {
    stubPrivate(false);

    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/clear`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ cleared: false });
    expect(res.body.message).toBe("No messages");
    expect(mocks.privateRoomRepo.setClearFor).not.toHaveBeenCalled();
    expect(mocks.privateMessageRepo.createMessage).not.toHaveBeenCalled();
    expect(bump).not.toHaveBeenCalled();
    expect(mocks.redis.publish).not.toHaveBeenCalled();
  });

  it("asks for clearable history AFTER the caller's existing cutoff", async () => {
    stubPrivate(false);
    const prior = "2026-08-10T10:15:00.000Z";
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, PEER],
      clearFor: { [TEST_USER_ID]: prior },
    });

    await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/clear`)
      .set(bearer(makeAccessToken()));

    expect(mocks.privateMessageRepo.hasClearableAfter).toHaveBeenCalledWith({
      roomId: ROOM,
      userId: TEST_USER_ID,
      cutoff: new Date(prior),
    });
  });
});

describe("POST /groups/rooms/:roomId/clear", () => {
  it("repaints the clearing member's row in place, no one else's", async () => {
    stubGroup(true);

    const res = await request(app)
      .post(`/api/chat/groups/rooms/${GROUP}/clear`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ cleared: true });
    expect(bump).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "GROUP",
        roomId: GROUP,
        recipientIds: [TEST_USER_ID],
        lastMessageId: "g3",
        lastMessageAt: LAST_AT.getTime(),
        preview: expect.objectContaining({
          contentType: "SYSTEM",
          systemEvent: "CONVERSATION_CLEARED",
        }),
        countInUnread: false,
      })
    );
    // Clear is not Leave: membership is never touched.
    expect(mocks.groupMemberRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("nothing to clear: a no-op that changes nothing", async () => {
    stubGroup(false);

    const res = await request(app)
      .post(`/api/chat/groups/rooms/${GROUP}/clear`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ cleared: false });
    expect(mocks.groupMemberRepo.setClearChatAt).not.toHaveBeenCalled();
    expect(mocks.groupMessageRepo.create).not.toHaveBeenCalled();
    expect(bump).not.toHaveBeenCalled();
  });
});
