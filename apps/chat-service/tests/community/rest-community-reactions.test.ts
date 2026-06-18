/**
 * Integration tests — community message react + edit (REST), focused on the
 * cross-channel broadcast fix.
 *
 * Route: POST /api/chat/community/messages/:messageId/react
 * Route: PATCH /api/chat/community/messages/:messageId
 *
 * Before this fix, both handlers broadcast on the body-supplied `communityId`
 * instead of the message's own `roomId`. Because GeneralRoom.id === communityId
 * the channels are identical for legitimate messages, but a caller could pass
 * any arbitrary communityId in the body and fan events onto a foreign community's
 * socket channel. The fix derives the channel from message.roomId (authoritative,
 * already auth-guarded by the service).
 *
 * These tests are the canonical regression coverage for that fix:
 *   B1 — body communityId ≠ message.roomId → broadcast goes to message.roomId,
 *         nothing emitted on the foreign channel.
 *
 * Mirrored from: tests/private/rest-reactions.test.ts (private/group IDOR B1)
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

/** Room the message actually lives in (real communityId per GeneralRoom invariant). */
const ROOM = "room-1";
/** A foreign community the caller is NOT authorized for and should not receive events. */
const FOREIGN = "foreign-comm-99";
const MSG = "msg-c1";
const EMOJI = "🔥";
const BASE = "/api/chat/community";

function publishesOn(redis: BuiltMocks["redis"], channel: string) {
  return redis.publish.mock.calls.filter(
    (c: unknown[]) => c[0] === channel
  ) as [string, string][];
}

function reactionPublishesOn(redis: BuiltMocks["redis"], channel: string) {
  return publishesOn(redis, channel).filter(([, payload]) =>
    payload.includes("message:reaction")
  );
}

function editPublishesOn(redis: BuiltMocks["redis"], channel: string) {
  return publishesOn(redis, channel).filter(([, payload]) =>
    payload.includes("message:edited")
  );
}

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

// ---------------------------------------------------------------------------
// POSITIVE — happy path (body communityId matches message.roomId)
// ---------------------------------------------------------------------------

describe("POST /community/messages/:messageId/react — POSITIVE", () => {
  it("200: adds reaction, broadcasts on community:${message.roomId}", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      deletedForAll: false,
      reactions: {},
    });
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
      role: "member",
    });

    const res = await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: EMOJI });

    expect(res.status).toBe(200);
    expect(mocks.generalRoomMessageRepo.updateById).toHaveBeenCalledTimes(1);
    expect(reactionPublishesOn(mocks.redis, `community:${ROOM}`)).toHaveLength(
      1
    );
  });

  it("403 — non-member cannot react", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      deletedForAll: false,
      reactions: {},
    });
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: EMOJI });

    expect(res.status).toBe(403);
    expect(mocks.generalRoomMessageRepo.updateById).not.toHaveBeenCalled();
    expect(reactionPublishesOn(mocks.redis, `community:${ROOM}`)).toHaveLength(
      0
    );
  });

  it("401 — no token", async () => {
    const res = await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .send({ communityId: ROOM, emoji: EMOJI });
    expect(res.status).toBe(401);
  });

  it("400 — missing emoji", async () => {
    const res = await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM });
    expect(res.status).toBe(400);
  });

  it("400 — emoji too long (>10 chars)", async () => {
    const res = await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: ROOM, emoji: "x".repeat(11) });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// B1: cross-channel IDOR — body communityId points at a foreign community
// ---------------------------------------------------------------------------

describe("B1: cross-channel IDOR — body communityId ≠ message.roomId", () => {
  /**
   * The attacker is an authorized member of ROOM, but passes communityId=FOREIGN
   * in the body. The mutation itself is correctly guarded (service uses
   * message.roomId). The fix ensures the broadcast also goes to the real room,
   * NOT to the foreign channel.
   */
  it("react: broadcast goes to message.roomId, NOT foreign communityId", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      deletedForAll: false,
      reactions: {},
    });
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
      role: "member",
    });

    const res = await request(app)
      .post(`${BASE}/messages/${MSG}/react`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: FOREIGN, emoji: EMOJI });

    expect(res.status).toBe(200);
    // Nothing leaked onto the foreign channel.
    expect(
      reactionPublishesOn(mocks.redis, `community:${FOREIGN}`)
    ).toHaveLength(0);
    // Event correctly published on the message's real room.
    expect(reactionPublishesOn(mocks.redis, `community:${ROOM}`)).toHaveLength(
      1
    );
  });

  it("edit: broadcast goes to result.roomId, NOT foreign communityId", async () => {
    const now = Date.now();
    mocks.generalRoomMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TEST_USER_ID,
      messageType: "text",
      deletedForAll: false,
      createdAt: new Date(now - 1000),
    });
    mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
      status: "active",
      role: "member",
    });
    mocks.generalRoomMessageRepo.editMessage.mockResolvedValue({
      id: MSG,
      roomId: ROOM,
      sentBy: TEST_USER_ID,
      messageType: "text",
      message: "edited",
      createdAt: new Date(now - 1000),
    });

    const res = await request(app)
      .patch(`${BASE}/messages/${MSG}`)
      .set(bearer(makeAccessToken()))
      .send({ communityId: FOREIGN, content: { text: "edited" } });

    expect(res.status).toBe(200);
    // Nothing leaked onto the foreign channel.
    expect(editPublishesOn(mocks.redis, `community:${FOREIGN}`)).toHaveLength(
      0
    );
    // Edit correctly published on the message's real room.
    expect(editPublishesOn(mocks.redis, `community:${ROOM}`)).toHaveLength(1);
  });
});
