/**
 * B1 regression — cross-room IDOR on chat WRITE paths (edit / delete / forward).
 *
 * Security fix `01a131f` bound message↔room on every chat write path so that a
 * caller legitimately authorized for the URL/body room can no longer mutate (or
 * re-broadcast) a message that actually lives in a DIFFERENT room. Each test here
 * is the NEGATIVE / attacker case: the participant/member guard for the *named*
 * room PASSES, but the target message resolves to another room the caller is NOT
 * in — so the room-bind guard must reject with **404** (NotFound, not Forbidden,
 * so foreign-message existence isn't leaked), the mutating repo method must NOT be
 * called, and ZERO matching `redis.publish` broadcasts may leak onto `conv:<room>`.
 *
 * This mirrors the reaction B1 block in rest-reactions.test.ts, extended to the
 * other write verbs. Two POSITIVE sanity tests are included only for the paths
 * whose happy-path room-bind isn't already covered elsewhere (the group delete +
 * the two forwards); private/group edit and private delete happy-paths already
 * live in private-message.test.ts / group-message.test.ts.
 *
 * Covered verbs & routes:
 *   group  delete  POST   /api/chat/groups/messages/delete           { messageId, roomId }
 *   private delete-for-me        DELETE /api/chat/private/messages/:messageId?type=forMe
 *   private delete-for-everyone  DELETE /api/chat/private/messages/:messageId?type=forEveryone
 *   private edit    PATCH  /api/chat/private/messages/:messageId      { content:{text} }
 *   group  edit     PATCH  /api/chat/groups/messages/:messageId       { content:{text} }
 *   private forward POST   /api/chat/private/rooms/:roomId/messages/:messageId/forward
 *   group  forward  POST   /api/chat/groups/rooms/:roomId/messages/:messageId/forward
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const PRV = "prv_room_1";
const GRP = "grp_room_1";
const MSG = "msg_1";

/** Filter redis.publish calls that emitted `event` on `conv:<roomId>`. */
function broadcastsFor(
  redis: BuiltMocks["redis"],
  roomId: string,
  event: string
) {
  return redis.publish.mock.calls.filter(
    (c: unknown[]) =>
      c[0] === `conv:${roomId}` &&
      typeof c[1] === "string" &&
      (c[1] as string).includes(event)
  );
}

beforeEach(() => {
  ({ app, mocks } = buildApp());
  // Reaction/enrichment paths read the snapshot cache; default to empty.
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

describe("B1 cross-room IDOR — group deleteMessage", () => {
  it("NEGATIVE: 404 when the message belongs to a different group; deleteForEveryone + broadcast skipped", async () => {
    // Caller is a legitimate ADMIN of the body roomId (GRP)…
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });
    // …but the target message actually lives in grp_OTHER (a group the caller
    // named GRP for, but does NOT own the message in).
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: "grp_OTHER",
      senderId: "victim",
    });

    const res = await request(app)
      .post(`/api/chat/groups/messages/delete`)
      .set(bearer(makeAccessToken()))
      .send({ messageId: MSG, roomId: GRP });

    expect(res.status).toBe(404);
    // The room-bind (message.roomId !== roomId) rejects BEFORE the mutation.
    expect(mocks.groupMessageRepo.deleteForEveryone).not.toHaveBeenCalled();
    // No foreign-message tombstone leaked onto conv:GRP.
    expect(broadcastsFor(mocks.redis, GRP, "message:delete")).toHaveLength(0);
  });

  it("POSITIVE (sanity): 200 when the message is in the body room; broadcasts message:delete", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "ADMIN",
    });
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: GRP,
      senderId: TEST_USER_ID,
    });
    mocks.groupMessageRepo.deleteForEveryone.mockResolvedValue({
      id: MSG,
      roomId: GRP,
      sequenceNumber: 4,
      deletedType: "SELF_DELETE",
    });

    const res = await request(app)
      .post(`/api/chat/groups/messages/delete`)
      .set(bearer(makeAccessToken()))
      .send({ messageId: MSG, roomId: GRP });

    expect(res.status).toBe(200);
    expect(mocks.groupMessageRepo.deleteForEveryone).toHaveBeenCalledTimes(1);
    expect(broadcastsFor(mocks.redis, GRP, "message:delete")).toHaveLength(1);
  });
});

describe("B1 cross-room IDOR — private deleteForMe", () => {
  it("NEGATIVE: 404 when the message's room has the caller absent; deleteForMe + broadcast skipped", async () => {
    // The message lives in prv_OTHER…
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: "prv_OTHER",
      isDeleted: false,
      deletedFor: {},
    });
    // …and the caller is NOT a participant of that room (someone_else + peer).
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: "prv_OTHER",
      participants: ["someone_else", "peer"],
    });

    // `type` is a required enum on this route (forMe|forEveryone); forMe routes
    // the controller to deleteForMe — where the room-bind guard runs.
    const res = await request(app)
      .delete(`/api/chat/private/messages/${MSG}?type=forMe`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
    expect(mocks.privateMessageRepo.deleteForMe).not.toHaveBeenCalled();
    // No tombstone for the foreign room.
    expect(
      broadcastsFor(mocks.redis, "prv_OTHER", "message:delete")
    ).toHaveLength(0);
  });
});

describe("B1 cross-room IDOR — private deleteForEveryone (?type=forEveryone)", () => {
  it("NEGATIVE: 404 when the message's room has the caller absent; deleteForEveryone skipped (room-bind precedes sender check)", async () => {
    // Caller is even the SENDER of the foreign message — the room-bind must still
    // reject (a user removed from a DM can't mutate their own old message).
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: "prv_OTHER",
      isDeleted: false,
      senderId: TEST_USER_ID,
      deletedFor: {},
    });
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: "prv_OTHER",
      participants: ["someone_else", "peer"],
    });

    const res = await request(app)
      .delete(`/api/chat/private/messages/${MSG}?type=forEveryone`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
    expect(mocks.privateMessageRepo.deleteForEveryone).not.toHaveBeenCalled();
    expect(
      broadcastsFor(mocks.redis, "prv_OTHER", "message:delete")
    ).toHaveLength(0);
  });
});

describe("B1 cross-room IDOR — private editMessage", () => {
  it("NEGATIVE: 404 when the message's room has the caller absent; editMessage + broadcast skipped", async () => {
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: "prv_OTHER",
      senderId: TEST_USER_ID,
      messageType: "TEXT",
      isDeleted: false,
      createdAt: new Date(),
    });
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: "prv_OTHER",
      participants: ["someone_else", "peer"],
    });

    const res = await request(app)
      .patch(`/api/chat/private/messages/${MSG}`)
      .set(bearer(makeAccessToken()))
      .send({ content: { text: "hijacked" } });

    expect(res.status).toBe(404);
    expect(mocks.privateMessageRepo.editMessage).not.toHaveBeenCalled();
    expect(
      broadcastsFor(mocks.redis, "prv_OTHER", "message:edited")
    ).toHaveLength(0);
  });
});

describe("B1 cross-room IDOR — group editMessage", () => {
  it("NEGATIVE: 404 when the caller is not an active member of the message's group; editMessage + broadcast skipped", async () => {
    // The message lives in grp_OTHER…
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: MSG,
      roomId: "grp_OTHER",
      senderId: TEST_USER_ID,
      messageType: "TEXT",
      isDeleted: false,
      createdAt: new Date(),
    });
    // …and the caller is NOT an active member of grp_OTHER (member lookup on the
    // message's OWN room returns null → NotFound).
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/chat/groups/messages/${MSG}`)
      .set(bearer(makeAccessToken()))
      .send({ content: { text: "hijacked" } });

    expect(res.status).toBe(404);
    expect(mocks.groupMessageRepo.editMessage).not.toHaveBeenCalled();
    expect(
      broadcastsFor(mocks.redis, "grp_OTHER", "message:edited")
    ).toHaveLength(0);
  });
});

describe("B1 cross-room IDOR — private forward (source-room bind)", () => {
  it("NEGATIVE: 404 when the caller is not a participant of the SOURCE room; createForwardedMessage + broadcast skipped", async () => {
    // Friendship gate (runs first) is satisfied.
    mocks.userServiceClient.checkFriendship.mockResolvedValue(true);
    // Source message exists and (truthfully) belongs to the path source room PRV…
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: "src",
      roomId: PRV,
      isDeleted: false,
      messageType: "TEXT",
      content: { text: "secret" },
      createdAt: new Date(10),
    });
    // …but the caller is NOT a participant of PRV (the source room they named in
    // the path) — so forwarding it would exfiltrate a message from a DM they're
    // not in. Source-room bind → NotFound. The caller IS in the target room, so
    // only the source bind can reject this.
    mocks.privateRoomRepo.findByRoomId.mockImplementation(
      async (roomId: string) =>
        roomId === PRV
          ? { roomId: PRV, participants: ["someone_else", "peer"] }
          : { roomId, participants: [TEST_USER_ID, "peer-2"] }
    );

    const res = await request(app)
      .post(`/api/chat/private/rooms/${PRV}/messages/src/forward`)
      .set(bearer(makeAccessToken()))
      .send({ targetRoomId: "prv_target_room", receiverId: "peer-2" });

    expect(res.status).toBe(404);
    expect(
      mocks.privateMessageRepo.createForwardedMessage
    ).not.toHaveBeenCalled();
    // Nothing fanned out onto the target room.
    expect(
      broadcastsFor(mocks.redis, "prv_target_room", "message:new")
    ).toHaveLength(0);
  });

  // AUDIT-104 — the SOURCE room was bound but the TARGET was not, so a caller
  // who was friends with whatever `receiverId` they claimed could inject a
  // message into any targetRoomId they could name: a DM they are not part of.
  it("NEGATIVE: 403 when the caller is not a participant of the TARGET room; nothing written or broadcast", async () => {
    mocks.userServiceClient.checkFriendship.mockResolvedValue(true);
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: "src",
      roomId: PRV,
      isDeleted: false,
      messageType: "TEXT",
      content: { text: "secret" },
      createdAt: new Date(10),
    });
    // The caller owns the SOURCE room but is a stranger to the TARGET.
    mocks.privateRoomRepo.findByRoomId.mockImplementation(
      async (roomId: string) =>
        roomId === PRV
          ? { roomId: PRV, participants: [TEST_USER_ID, "peer"] }
          : { roomId, participants: ["victim_a", "victim_b"] }
    );

    const res = await request(app)
      .post(`/api/chat/private/rooms/${PRV}/messages/src/forward`)
      .set(bearer(makeAccessToken()))
      .send({ targetRoomId: "prv_someone_elses_dm", receiverId: "victim_a" });

    expect(res.status).toBe(403);
    expect(
      mocks.privateMessageRepo.createForwardedMessage
    ).not.toHaveBeenCalled();
    expect(
      broadcastsFor(mocks.redis, "prv_someone_elses_dm", "message:new")
    ).toHaveLength(0);
  });

  it("NEGATIVE: 404 when the source message belongs to a DIFFERENT room than the path source room", async () => {
    mocks.userServiceClient.checkFriendship.mockResolvedValue(true);
    // Caller IS a participant of the named source room PRV…
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: PRV,
      participants: [TEST_USER_ID, "peer"],
    });
    // …but the source message actually lives in prv_OTHER (source.roomId !== PRV)
    // — a caller passes a foreign messageId under a room they happen to be in.
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: "src",
      roomId: "prv_OTHER",
      isDeleted: false,
      messageType: "TEXT",
      content: { text: "secret" },
      createdAt: new Date(10),
    });

    const res = await request(app)
      .post(`/api/chat/private/rooms/${PRV}/messages/src/forward`)
      .set(bearer(makeAccessToken()))
      .send({ targetRoomId: "prv_target_room", receiverId: "peer-2" });

    expect(res.status).toBe(404);
    expect(
      mocks.privateMessageRepo.createForwardedMessage
    ).not.toHaveBeenCalled();
    expect(
      broadcastsFor(mocks.redis, "prv_target_room", "message:new")
    ).toHaveLength(0);
  });

  it("POSITIVE (sanity): 201 when the caller is a participant of the SOURCE room and the message belongs to it", async () => {
    mocks.userServiceClient.checkFriendship.mockResolvedValue(true);
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: "src",
      roomId: PRV,
      isDeleted: false,
      messageType: "TEXT",
      content: { text: "fwd" },
      createdAt: new Date(10),
    });
    mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
      roomId: PRV,
      participants: [TEST_USER_ID, "peer"],
    });
    mocks.privateMessageRepo.createForwardedMessage.mockResolvedValue({
      id: "fwd1",
      messageType: "TEXT",
      content: { text: "fwd" },
      createdAt: new Date(20),
    });

    const res = await request(app)
      .post(`/api/chat/private/rooms/${PRV}/messages/src/forward`)
      .set(bearer(makeAccessToken()))
      .send({ targetRoomId: "prv_target_room", receiverId: "peer-2" });

    expect(res.status).toBe(201);
    expect(
      mocks.privateMessageRepo.createForwardedMessage
    ).toHaveBeenCalledTimes(1);
    expect(
      broadcastsFor(mocks.redis, "prv_target_room", "message:new")
    ).toHaveLength(1);
  });
});

describe("B1 cross-room IDOR — group forward (source-room bind)", () => {
  it("NEGATIVE: 404 when the source message belongs to a DIFFERENT group than the path source room; createForwardedMessage + broadcast skipped", async () => {
    // Member-of-TARGET check (runs first) passes; member-of-SOURCE check passes
    // too — but the source message's roomId doesn't match the named source room.
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: "src",
      roomId: "grp_OTHER",
      isDeleted: false,
      messageType: "TEXT",
      content: { text: "secret" },
      createdAt: new Date(10),
    });

    const res = await request(app)
      .post(`/api/chat/groups/rooms/${GRP}/messages/src/forward`)
      .set(bearer(makeAccessToken()))
      .send({ targetRoomId: "grp_target_room" });

    expect(res.status).toBe(404);
    expect(
      mocks.groupMessageRepo.createForwardedMessage
    ).not.toHaveBeenCalled();
    expect(
      broadcastsFor(mocks.redis, "grp_target_room", "message:new")
    ).toHaveLength(0);
  });

  it("NEGATIVE: 404 when the caller is not an active member of the SOURCE room", async () => {
    // Member-of-TARGET passes (first lookup), member-of-SOURCE fails (second).
    // The source message truthfully belongs to GRP, so only the source-membership
    // bind can reject — proving the per-room membership check, not just roomId.
    mocks.groupMemberRepo.findActiveByRoomAndUser
      .mockResolvedValueOnce({ role: "MEMBER" }) // target room: ok
      .mockResolvedValueOnce(null); // source room (GRP): not a member
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: "src",
      roomId: GRP,
      isDeleted: false,
      messageType: "TEXT",
      content: { text: "secret" },
      createdAt: new Date(10),
    });

    const res = await request(app)
      .post(`/api/chat/groups/rooms/${GRP}/messages/src/forward`)
      .set(bearer(makeAccessToken()))
      .send({ targetRoomId: "grp_target_room" });

    expect(res.status).toBe(404);
    expect(
      mocks.groupMessageRepo.createForwardedMessage
    ).not.toHaveBeenCalled();
    expect(
      broadcastsFor(mocks.redis, "grp_target_room", "message:new")
    ).toHaveLength(0);
  });

  it("POSITIVE (sanity): 201 when the caller is an active member of both target and source, and the message belongs to the source", async () => {
    mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
      role: "MEMBER",
    });
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: "src",
      roomId: GRP,
      isDeleted: false,
      messageType: "TEXT",
      content: { text: "fwd" },
      createdAt: new Date(10),
    });
    mocks.groupMessageRepo.createForwardedMessage.mockResolvedValue({
      id: "fwd1",
      messageType: "TEXT",
      content: { text: "fwd" },
      createdAt: new Date(20),
    });

    const res = await request(app)
      .post(`/api/chat/groups/rooms/${GRP}/messages/src/forward`)
      .set(bearer(makeAccessToken()))
      .send({ targetRoomId: "grp_target_room" });

    expect(res.status).toBe(201);
    expect(mocks.groupMessageRepo.createForwardedMessage).toHaveBeenCalledTimes(
      1
    );
    expect(
      broadcastsFor(mocks.redis, "grp_target_room", "message:new")
    ).toHaveLength(1);
  });
});
