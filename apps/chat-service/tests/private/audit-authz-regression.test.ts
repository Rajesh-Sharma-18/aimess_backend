/**
 * QA-audit regression suite — the private-chat authorization and fan-out holes.
 *
 * Each test is the attacker case from the finding it names. They live together
 * because they share one root cause: the private write paths trusted the CALLER
 * for two things the ROOM is the only authority on — whether the caller belongs
 * to it, and who the other side is.
 *
 *   AUDIT-103  POST /private/rooms/:roomId/messages          — no participation check
 *   AUDIT-104  …/messages/:id/forward                        — TARGET room unbound
 *   AUDIT-105  POST /private/rooms/:roomId/read              — forged read receipts
 *   AUDIT-106  client receiverId → over-delivery             — fan-out to a stranger
 *   AUDIT-115  client receiverId omitted → under-delivery    — peer gets nothing
 *   AUDIT-113  GET  …/messages/:id/reactions                 — reactor list leak
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "prv_room_1";
const PEER = "44444444-4444-4444-8444-444444444444";
const OUTSIDER = "55555555-5555-4555-8555-555555555555";

/** The room the caller IS in, with `PEER` on the other side. */
function callerIsParticipant() {
  mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
    roomId: ROOM,
    participants: [TEST_USER_ID, PEER],
  });
}

/** A room between two other people — the caller is a stranger to it. */
function callerIsOutsider() {
  mocks.privateRoomRepo.findByRoomId.mockResolvedValue({
    roomId: ROOM,
    participants: [PEER, OUTSIDER],
  });
}

/** Channels a `message:new` was published on. */
function messageNewChannels(): string[] {
  return mocks.redis.publish.mock.calls
    .filter(
      (c: unknown[]) =>
        typeof c[1] === "string" && (c[1] as string).includes('"message:new"')
    )
    .map((c: unknown[]) => c[0] as string);
}

function stubSuccessfulInsert() {
  mocks.userServiceClient.checkFriendship.mockResolvedValue(true);
  mocks.privateMessageRepo.findByClientMessageId.mockResolvedValue(null);
  mocks.privateRoomRepo.allocateSequenceBlock.mockResolvedValue({
    lastSequence: 5,
    lastRevision: 5,
    room: { roomId: ROOM, lastMessageAt: new Date(1) },
  });
  mocks.privateMessageRepo.createMessage.mockImplementation(
    async (data: Record<string, unknown>) => ({
      id: "msg_new_1",
      messageType: "TEXT",
      content: { text: "hello" },
      sequenceNumber: 5,
      revision: 5,
      createdAt: new Date(1000),
      // The row echoes back whatever the SERVICE decided the receiver is —
      // which is the whole point of AUDIT-106/115.
      receiverId: data.receiverId,
    })
  );
}

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

describe("AUDIT-103 — send requires participation, not just friendship", () => {
  it("SECURITY: 403 posting into a room the caller is not a participant of", async () => {
    callerIsOutsider();
    // The friendship gate PASSES — that is exactly why it was not enough on its
    // own: being friends with someone does not put you in a given room.
    mocks.userServiceClient.checkFriendship.mockResolvedValue(true);

    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()))
      .send({ receiverId: PEER, content: { text: "hi" }, messageType: "TEXT" });

    expect(res.status).toBe(403);
    expect(mocks.privateMessageRepo.createMessage).not.toHaveBeenCalled();
  });

  it("runs the guard BEFORE the friendship round-trip and before a sequence is burned", async () => {
    callerIsOutsider();

    await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()))
      .send({ receiverId: PEER, content: { text: "hi" }, messageType: "TEXT" });

    expect(mocks.userServiceClient.checkFriendship).not.toHaveBeenCalled();
    expect(mocks.privateRoomRepo.allocateSequenceBlock).not.toHaveBeenCalled();
  });

  it("POSITIVE: a real participant still sends", async () => {
    callerIsParticipant();
    stubSuccessfulInsert();

    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()))
      .send({
        receiverId: PEER,
        content: { text: "hello" },
        messageType: "TEXT",
      });

    expect(res.status).toBe(201);
  });
});

describe("AUDIT-106/115 — the peer comes from the room, never the client", () => {
  it("SECURITY: a forged receiverId does not deliver to that third party", async () => {
    callerIsParticipant();
    stubSuccessfulInsert();

    await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()))
      .send({
        // The caller names someone who is NOT in this room.
        receiverId: OUTSIDER,
        content: { text: "hello" },
        messageType: "TEXT",
      });

    expect(mocks.privateMessageRepo.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ receiverId: PEER })
    );
    const channels = messageNewChannels();
    expect(channels).toContain(`conv:${ROOM}`);
    expect(channels).toContain(`user:${PEER}`);
    expect(channels).not.toContain(`user:${OUTSIDER}`);
  });

  it("an OMITTED receiverId still reaches the real peer (no silent drop)", async () => {
    callerIsParticipant();
    stubSuccessfulInsert();

    await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()))
      .send({ content: { text: "hello" }, messageType: "TEXT" });

    expect(mocks.privateMessageRepo.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ receiverId: PEER })
    );
    // It used to publish to `user:""` — a channel nobody is subscribed to.
    const channels = messageNewChannels();
    expect(channels).toContain(`user:${PEER}`);
    expect(channels).not.toContain("user:");
  });
});

describe("AUDIT-105 — mark-read requires participation", () => {
  beforeEach(() => {
    // `roomId` is REQUIRED now: the read target is bound to the room before the
    // watermark advances, so a message that names no room (or another one) is
    // not an acceptable read target.
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: "msg_hw_1",
      roomId: ROOM,
      sequenceNumber: 9,
    });
  });

  it("SECURITY: 403 marking a conversation read the caller is not in", async () => {
    callerIsOutsider();

    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/read`)
      .set(bearer(makeAccessToken()))
      .send({ upToMessageId: "msg_hw_1" });

    expect(res.status).toBe(403);
    // Neither the read pointer nor the receipt may move.
    expect(mocks.privateRoomRepo.markReadUpTo).not.toHaveBeenCalled();
    const readEvents = mocks.redis.publish.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[1] === "string" && (c[1] as string).includes('"message:read"')
    );
    expect(readEvents).toHaveLength(0);
  });

  it("POSITIVE: a participant still marks read", async () => {
    callerIsParticipant();
    mocks.privateRoomRepo.markReadUpTo.mockResolvedValue({
      participants: [TEST_USER_ID, PEER],
      unreadCountByUser: { [TEST_USER_ID]: 0 },
      lastMessageId: "msg_hw_1",
    });

    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/read`)
      .set(bearer(makeAccessToken()))
      .send({ upToMessageId: "msg_hw_1" });

    expect(res.status).toBe(200);
    expect(mocks.privateRoomRepo.markReadUpTo).toHaveBeenCalled();
  });

  it("SECURITY: a FOREIGN target mutates nothing and publishes nothing", async () => {
    // A message id from another conversation used to resolve to that room's
    // sequence number, which was then written into THIS room's read pointer
    // and used to recompute its unread count.
    callerIsParticipant();
    mocks.privateMessageRepo.findById.mockResolvedValue({
      id: "msg_hw_1",
      roomId: "prv_some_other_room",
      sequenceNumber: 900,
    });

    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/read`)
      .set(bearer(makeAccessToken()))
      .send({ upToMessageId: "msg_hw_1" });

    expect(res.status).toBe(200); // accepted, but a no-op
    expect(mocks.privateRoomRepo.markReadUpTo).not.toHaveBeenCalled();
    expect(mocks.privateMessageRepo.armAfterViewing).not.toHaveBeenCalled();
    const readEvents = mocks.redis.publish.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[1] === "string" && (c[1] as string).includes('"message:read"')
    );
    expect(readEvents).toHaveLength(0);
  });
});

describe("AUDIT-113 — private reactor list is participant-gated", () => {
  it("SECURITY: 403 reading reactions of a conversation the caller is not in", async () => {
    callerIsOutsider();

    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/messages/m1/reactions`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(403);
    expect(mocks.privateMessageRepo.getReactions).not.toHaveBeenCalled();
  });

  // The route used to address the row by messageId ALONE, so a participant of
  // room A could read the reactors of a message in room B.
  it("SECURITY: 404 when the message belongs to a different room", async () => {
    callerIsParticipant();
    mocks.privateMessageRepo.findMessageMeta.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/messages/m1/reactions`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(404);
    expect(mocks.privateMessageRepo.getReactions).not.toHaveBeenCalled();
  });

  it("POSITIVE: a participant reads the grouped reactions", async () => {
    callerIsParticipant();
    mocks.privateMessageRepo.findMessageMeta.mockResolvedValue({
      id: "m1",
      roomId: ROOM,
    });
    mocks.privateMessageRepo.getReactions.mockResolvedValue({
      reactions: { "🔥": ["u1", "u2"] },
      roomId: ROOM,
    });

    const res = await request(app)
      .get(`/api/chat/private/rooms/${ROOM}/messages/m1/reactions`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.reactions["🔥"].count).toBe(2);
  });
});
