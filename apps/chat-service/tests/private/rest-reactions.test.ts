/**
 * Integration tests — REST react / remove-reaction (private + group), routed
 * through ChatMessageOrchestrator.reactDirect.
 *
 * Routes:
 *   POST   /api/chat/private/rooms/:roomId/messages/:messageId/reactions      (add)
 *   DELETE /api/chat/private/rooms/:roomId/messages/:messageId/reactions/:emoji (remove)
 *   POST   /api/chat/groups/:roomId/messages/:messageId/reactions             (add)
 *   DELETE /api/chat/groups/:roomId/messages/:messageId/reactions/:emoji      (remove)
 *
 * These exercise the REAL controller → orchestrator → *MessageService path with
 * mock repos (the app-factory harness), so routing, Zod validation, the REST
 * participant/member authz guard, the idempotent toggle, and the Redis
 * message:reaction fan-out all run for real.
 *
 * Idempotency model: reactDirect reads the current reaction state, toggles the
 * underlying service.react() ONLY when the op would change state, then re-reads
 * and broadcasts. The service.react() primitive is a toggle, so the wrapper makes
 * POST=add and DELETE=remove idempotent.
 *
 * getReactions call accounting per request:
 *   - reactDirect reads BEFORE (getMessageReactions → getReactions #1).
 *   - if the op changes state, service.react() reads AGAIN (getReactions #2) then
 *     addReactions.
 *   - reactDirect reads AFTER (getMessageReactions → getReactions #last).
 * So a state-changing op makes THREE getReactions reads (#1 before, #2 inside
 * react, #3 after); an idempotent no-op makes TWO (before + after, react skipped).
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "prv_room_1";
const MSG = "msg_1";
const EMOJI = "👍";

/** A stored reactor map where TEST_USER_ID has reacted with EMOJI. */
const REACTED_BY_SELF = {
  [EMOJI]: [{ userId: TEST_USER_ID, userName: "", avatar: "", memberId: "" }],
};

/** Filter redis.publish calls that emitted message:reaction on conv:<roomId>. */
function reactionBroadcasts(redis: BuiltMocks["redis"], roomId: string) {
  return redis.publish.mock.calls.filter(
    (c: unknown[]) =>
      c[0] === `conv:${roomId}` &&
      typeof c[1] === "string" &&
      (c[1] as string).includes("message:reaction")
  );
}

beforeEach(() => {
  ({ app, mocks } = buildApp());
  // getMessageReactions → userSnapshotService → cacheRepo.getUserSnapshots.
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

describe("POST /private/rooms/:roomId/messages/:messageId/reactions (add)", () => {
  it("POSITIVE: 200 adds the reaction, calls react once, returns groups, broadcasts message:reaction", async () => {
    // Participant guard passes.
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, "peer_1"],
    });
    // #1 before + #2 inside react: not yet reacted → toggle ON fires;
    // #3 after-read: reacted.
    mocks.privateMessageRepo.getReactions
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(REACTED_BY_SELF);
    mocks.privateMessageRepo.addReactions.mockResolvedValue({ id: MSG });

    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages/${MSG}/reactions`)
      .set(bearer(makeAccessToken()))
      .send({ emoji: EMOJI });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.reactions).toEqual([
      {
        emoji: EMOJI,
        count: 1,
        users: [{ userId: TEST_USER_ID, displayName: "", avatar: "" }],
      },
    ]);
    // Toggle fired exactly once (add when absent).
    expect(mocks.privateMessageRepo.addReactions).toHaveBeenCalledTimes(1);
    expect(reactionBroadcasts(mocks.redis, ROOM)).toHaveLength(1);
  });

  it("IDEMPOTENT: 200 no-op when the caller already reacted; react NOT called again, still 200 + groups", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, "peer_1"],
    });
    // Already reacted on BOTH reads → add is a no-op (no toggle).
    mocks.privateMessageRepo.getReactions.mockResolvedValue(REACTED_BY_SELF);

    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages/${MSG}/reactions`)
      .set(bearer(makeAccessToken()))
      .send({ emoji: EMOJI });

    expect(res.status).toBe(200);
    expect(res.body.data.reactions).toHaveLength(1);
    // The underlying toggle must NOT run on an idempotent re-add.
    expect(mocks.privateMessageRepo.addReactions).not.toHaveBeenCalled();
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages/${MSG}/reactions`)
      .send({ emoji: EMOJI });
    expect(res.status).toBe(401);
    expect(mocks.privateMessageRepo.getReactions).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 400 on an empty emoji", async () => {
    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages/${MSG}/reactions`)
      .set(bearer(makeAccessToken()))
      .send({ emoji: "" });
    expect(res.status).toBe(400);
    expect(mocks.privateMessageRepo.addReactions).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 400 on a too-long emoji (>32 chars)", async () => {
    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages/${MSG}/reactions`)
      .set(bearer(makeAccessToken()))
      .send({ emoji: "x".repeat(33) });
    expect(res.status).toBe(400);
    expect(mocks.privateMessageRepo.addReactions).not.toHaveBeenCalled();
  });

  it("SECURITY: 403 when the caller is not a participant of the room", async () => {
    // Room exists but the caller is not in participants → assertPrivateParticipant 403.
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: ["someone_else", "peer_1"],
    });

    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages/${MSG}/reactions`)
      .set(bearer(makeAccessToken()))
      .send({ emoji: EMOJI });

    expect(res.status).toBe(403);
    // Guard runs BEFORE any reaction read/write.
    expect(mocks.privateMessageRepo.getReactions).not.toHaveBeenCalled();
    expect(mocks.privateMessageRepo.addReactions).not.toHaveBeenCalled();
  });
});

describe("DELETE /private/rooms/:roomId/messages/:messageId/reactions/:emoji (remove)", () => {
  it("POSITIVE: 200 removes the reaction (toggle off), broadcasts message:reaction", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, "peer_1"],
    });
    // #1 before + #2 inside react: reacted → toggle OFF fires; #3 after: empty.
    mocks.privateMessageRepo.getReactions
      .mockResolvedValueOnce(REACTED_BY_SELF)
      .mockResolvedValueOnce(REACTED_BY_SELF)
      .mockResolvedValueOnce({});
    mocks.privateMessageRepo.addReactions.mockResolvedValue({ id: MSG });

    const res = await request(app)
      .delete(
        `/api/chat/private/rooms/${ROOM}/messages/${MSG}/reactions/${encodeURIComponent(EMOJI)}`
      )
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.reactions).toEqual([]);
    expect(mocks.privateMessageRepo.addReactions).toHaveBeenCalledTimes(1);
    expect(reactionBroadcasts(mocks.redis, ROOM)).toHaveLength(1);
  });

  it("IDEMPOTENT: 200 no-op when the caller has not reacted; react NOT called", async () => {
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: ROOM,
      participants: [TEST_USER_ID, "peer_1"],
    });
    // No reaction present on both reads → remove is a no-op.
    mocks.privateMessageRepo.getReactions.mockResolvedValue({});

    const res = await request(app)
      .delete(
        `/api/chat/private/rooms/${ROOM}/messages/${MSG}/reactions/${encodeURIComponent(EMOJI)}`
      )
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.reactions).toEqual([]);
    expect(mocks.privateMessageRepo.addReactions).not.toHaveBeenCalled();
  });

  it("SECURITY: 401 without a token", async () => {
    const res = await request(app).delete(
      `/api/chat/private/rooms/${ROOM}/messages/${MSG}/reactions/${encodeURIComponent(EMOJI)}`
    );
    expect(res.status).toBe(401);
  });
});

describe("GROUP react routes (orchestrator GROUP branch + member guard)", () => {
  const GROUP = "grp_room_1";

  it("POSITIVE: 200 add — active-member guard passes, react fires, broadcasts message:reaction", async () => {
    // assertGroupMember → groupMemberRepo.findActiveByRoomAndUser.
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });
    // #1 before + #2 inside react: empty; #3 after: reacted.
    mocks.groupMessageRepo.getReactions
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(REACTED_BY_SELF);
    mocks.groupMessageRepo.addReactions.mockResolvedValue({ id: MSG });

    const res = await request(app)
      .post(`/api/chat/groups/${GROUP}/messages/${MSG}/reactions`)
      .set(bearer(makeAccessToken()))
      .send({ emoji: EMOJI });

    expect(res.status).toBe(200);
    expect(res.body.data.reactions).toHaveLength(1);
    expect(mocks.groupMessageRepo.addReactions).toHaveBeenCalledTimes(1);
    expect(reactionBroadcasts(mocks.redis, GROUP)).toHaveLength(1);
  });

  it("SECURITY: 403 when the caller is not an active group member", async () => {
    // No active membership → assertGroupMember 403.
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/chat/groups/${GROUP}/messages/${MSG}/reactions`)
      .set(bearer(makeAccessToken()))
      .send({ emoji: EMOJI });

    expect(res.status).toBe(403);
    expect(mocks.groupMessageRepo.getReactions).not.toHaveBeenCalled();
    expect(mocks.groupMessageRepo.addReactions).not.toHaveBeenCalled();
  });
});
