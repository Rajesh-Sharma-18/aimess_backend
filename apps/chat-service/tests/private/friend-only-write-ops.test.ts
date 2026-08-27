/**
 * Integration tests — the friend-only rule on private-chat WRITE paths.
 *
 * "Not friends → no interaction" was enforced on `sendMessage` and (friendship
 * only, no block check) on `forwardMessage`, but nowhere else. Every other write
 * was authorized by ROOM PARTICIPATION alone — and participation stays true
 * forever once the room exists, since an unfriend or a block deletes neither the
 * room nor its history. So a non-friend could still react to and edit messages
 * in a conversation they were no longer allowed to send into, straight over REST,
 * with the UI hidden or not.
 *
 * These tests drive the REAL controller → orchestrator → PrivateMessageService
 * stack against the app-factory's mock repos, so routing, the participation
 * guard and the new friend-only guard all run for real. READS are deliberately
 * NOT gated — the history must stay visible after an unfriend — so a positive
 * read case is included to pin that down.
 *
 * Routes under test:
 *   POST  /api/chat/private/rooms/:roomId/messages/:messageId/reactions
 *   PATCH /api/chat/private/messages/:messageId
 *   POST  /api/chat/private/rooms/:roomId/messages/:messageId/forward
 *   POST  /api/chat/private/rooms/:roomId/messages          (already gated; regression)
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "prv_room_1";
const PEER = "peer_1";
const MSG = "msg_1";

/** The pair share a room and the caller is in it — participation always passes. */
function participantRoom() {
  return { roomId: ROOM, participants: [TEST_USER_ID, PEER], blockedBy: [] };
}

/** An editable TEXT message the caller owns, living in ROOM. */
function ownTextMessage() {
  return {
    id: MSG,
    roomId: ROOM,
    senderId: TEST_USER_ID,
    messageType: "TEXT",
    isDeleted: false,
    content: { text: "hello" },
    createdAt: new Date(),
  };
}

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  mocks.privateRoomRepo.findByRoomId.mockResolvedValue(participantRoom());
  mocks.privateMessageRepo.findMessageMeta.mockResolvedValue({
    id: MSG,
    roomId: ROOM,
  });
  mocks.privateMessageRepo.findById.mockResolvedValue(ownTextMessage());
  mocks.privateMessageRepo.getReactions.mockResolvedValue({
    roomId: ROOM,
    reactions: {},
  });
  mocks.privateMessageRepo.addReactions.mockResolvedValue({ id: MSG });
  // reactCas writes through a revision-matched CAS; an unmocked (falsy) result
  // reads as "lost the race" and retries out to a 409.
  mocks.privateMessageRepo.updateReactionsCas.mockResolvedValue(true);
  mocks.privateMessageRepo.editMessage.mockResolvedValue({
    ...ownTextMessage(),
    content: { text: "edited" },
  });
});

/** The four states user-service can report for a pair. */
const NOT_FRIENDS = () => {
  mocks.userServiceClient.checkFriendship.mockResolvedValue(false);
  mocks.userServiceClient.isBlockedEitherWay.mockResolvedValue(false);
};
/** Either direction — the gate cannot tell blocker from blocked, by design. */
const BLOCKED = () => {
  mocks.userServiceClient.checkFriendship.mockResolvedValue(false);
  mocks.userServiceClient.isBlockedEitherWay.mockResolvedValue(true);
};
const FRIENDS = () => {
  mocks.userServiceClient.checkFriendship.mockResolvedValue(true);
  mocks.userServiceClient.isBlockedEitherWay.mockResolvedValue(false);
};

describe("private react — friend-only", () => {
  const react = () =>
    request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages/${MSG}/reactions`)
      .set(bearer(makeAccessToken()))
      .send({ emoji: "👍" });

  it("POSITIVE: friends → 200 and the reaction is persisted", async () => {
    FRIENDS();
    const res = await react();
    expect(res.status).toBe(200);
    expect(mocks.privateMessageRepo.updateReactionsCas).toHaveBeenCalled();
  });

  it("NEGATIVE: not friends → 403 and nothing is written", async () => {
    NOT_FRIENDS();
    const res = await react();
    expect(res.status).toBe(403);
    expect(mocks.privateMessageRepo.updateReactionsCas).not.toHaveBeenCalled();
  });

  it("NEGATIVE: blocked → 403 CHAT_BLOCKED, not a generic friendship error", async () => {
    BLOCKED();
    const res = await react();
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/BLOCKED|block/i);
    expect(mocks.privateMessageRepo.updateReactionsCas).not.toHaveBeenCalled();
  });
});

describe("private editMessage — friend-only", () => {
  const edit = () =>
    request(app)
      .patch(`/api/chat/private/messages/${MSG}`)
      .set(bearer(makeAccessToken()))
      .send({ content: { text: "edited" } });

  it("POSITIVE: friends → 200 and the edit is persisted", async () => {
    FRIENDS();
    const res = await edit();
    expect(res.status).toBe(200);
    expect(mocks.privateMessageRepo.editMessage).toHaveBeenCalled();
  });

  it("NEGATIVE: not friends → 403; editing your OWN old message is still a write", async () => {
    NOT_FRIENDS();
    const res = await edit();
    expect(res.status).toBe(403);
    expect(mocks.privateMessageRepo.editMessage).not.toHaveBeenCalled();
  });
});

describe("private forward — friend-only (target room)", () => {
  const forward = () =>
    request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages/${MSG}/forward`)
      .set(bearer(makeAccessToken()))
      .send({ targetRoomId: "prv_target", receiverId: PEER });

  it("NEGATIVE: not friends with the target peer → 403, nothing written", async () => {
    NOT_FRIENDS();
    const res = await forward();
    expect(res.status).toBe(403);
    expect(
      mocks.privateMessageRepo.createForwardedMessage
    ).not.toHaveBeenCalled();
  });

  // The forward path checked friendship but never the block, so a blocked pair
  // that somehow still read as "friends" in the replica could forward through it.
  it("NEGATIVE: blocked → 403, nothing written", async () => {
    BLOCKED();
    mocks.userServiceClient.checkFriendship.mockResolvedValue(true);
    const res = await forward();
    expect(res.status).toBe(403);
    expect(
      mocks.privateMessageRepo.createForwardedMessage
    ).not.toHaveBeenCalled();
  });
});

describe("private sendMessage — friend-only (regression)", () => {
  it("NEGATIVE: not friends → 403, no message row", async () => {
    NOT_FRIENDS();
    const res = await request(app)
      .post(`/api/chat/private/rooms/${ROOM}/messages`)
      .set(bearer(makeAccessToken()))
      .send({ content: { text: "hi" }, messageType: "TEXT" });

    expect(res.status).toBe(403);
    expect(mocks.privateMessageRepo.create).not.toHaveBeenCalled();
  });
});

describe("deleting your own message stays open after an unfriend", () => {
  // Taking your own content back is not an "interaction" with the peer, and a
  // user who has just unfriended someone is exactly who wants to do it — so
  // delete is deliberately NOT behind the friend-only guard.
  it("POSITIVE: not friends → delete-for-me still succeeds", async () => {
    NOT_FRIENDS();
    mocks.privateMessageRepo.deleteForMe.mockResolvedValue({
      ...ownTextMessage(),
      deletedFor: { [TEST_USER_ID]: Date.now() },
    });

    const res = await request(app)
      .delete(`/api/chat/private/messages/${MSG}?type=forMe`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.privateMessageRepo.deleteForMe).toHaveBeenCalled();
  });
});
