/**
 * A private room's `participants` must be two distinct user UUIDs.
 *
 * `UserServiceClient.checkFriendship` fails OPEN — an unresolved upstream and a
 * DB error both `return true` — so during any user-service blip the
 * get-or-create path minted a room for whatever string sat in the URL. The dev
 * database carries the result: rooms whose peer is a `grp_...` room id, and two
 * whose peer is the literal "undefined". Neither can ever resolve to a person,
 * so such a row would serialize with a placeholder name forever; it stays out
 * of the inbox only because it has no `lastMessageAt`.
 *
 * The guard lives at `PrivateRoomRepository.create`, the one choke point every
 * creation passes through, so the REST get-or-create, the Auto-Connect gRPC
 * batch, the friendship consumer and both invite-share paths are all covered.
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import { assertPrivateParticipants, isUserId } from "../../src/lib/room-id.js";

const PEER_ID = "6dc54785-fbed-474b-a9c8-2d51ea1fe861";

let app: import("express").Express;
let mocks: BuiltMocks;

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  // No room for this pair yet, so the request reaches the create path.
  mocks.privateRoomRepo.findByParticipantsKey.mockResolvedValue(null);
});

describe("assertPrivateParticipants", () => {
  it.each([
    ["the literal string 'undefined'", [PEER_ID, "undefined"]],
    ["a group room id", [PEER_ID, "grp_sZgOCCniUKBnxqMu"]],
    ["a community ObjectId", [PEER_ID, "6a7bf9214d6c5b8b86a11aa8"]],
    ["a private room id", [PEER_ID, "prv_OrqmmJAT8sHO8Ds5"]],
    ["an empty string", [PEER_ID, ""]],
    ["the same user twice", [PEER_ID, PEER_ID]],
    ["a single participant", [PEER_ID]],
  ])("rejects %s", (_label, participants) => {
    expect(() => assertPrivateParticipants(participants)).toThrow(
      "CHAT_INVALID_ID_FORMAT"
    );
  });

  it("accepts two distinct user UUIDs", () => {
    expect(() =>
      assertPrivateParticipants([TEST_USER_ID, PEER_ID])
    ).not.toThrow();
  });

  it("isUserId separates a user id from every room id shape", () => {
    expect(isUserId(PEER_ID)).toBe(true);
    expect(isUserId("grp_sZgOCCniUKBnxqMu")).toBe(false);
    expect(isUserId("6a7bf9214d6c5b8b86a11aa8")).toBe(false);
    expect(isUserId("undefined")).toBe(false);
    expect(isUserId(undefined)).toBe(false);
  });
});

describe("POST /api/chat/private/rooms/:peerId — junk peer id", () => {
  /**
   * The friendship gate deliberately allows here (that is its fail-open
   * policy), so this proves the SHAPE guard is what stops the write — not luck
   * about which upstream happened to answer.
   */
  beforeEach(() => {
    mocks.userServiceClient.checkFriendship.mockResolvedValue(true);
  });

  it.each(["undefined", "grp_sZgOCCniUKBnxqMu", "6a7bf9214d6c5b8b86a11aa8"])(
    "refuses %s and creates NO room",
    async (junkPeerId) => {
      const res = await request(app)
        .post(`/api/chat/private/rooms/${junkPeerId}`)
        .set(bearer(makeAccessToken()));

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain("CHAT_INVALID_ID_FORMAT");
      expect(mocks.privateRoomRepo.create).not.toHaveBeenCalled();
    }
  );

  it("REGRESSION: a real peer uuid still gets a room", async () => {
    mocks.privateRoomRepo.create.mockResolvedValue({
      roomId: "prv_new",
      participants: [TEST_USER_ID, PEER_ID].sort(),
      lastMessageAt: null,
      lastMessage: null,
      unreadCountByUser: {},
      mutedBy: {},
      pinnedCount: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    const res = await request(app)
      .post(`/api/chat/private/rooms/${PEER_ID}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(mocks.privateRoomRepo.create).toHaveBeenCalledTimes(1);
    expect(mocks.privateRoomRepo.create.mock.calls[0][0].participants).toEqual(
      [TEST_USER_ID, PEER_ID].sort()
    );
  });

  it("REGRESSION: an existing room for the pair is reused, not re-created", async () => {
    mocks.privateRoomRepo.findByParticipantsKey.mockResolvedValue({
      roomId: "prv_existing",
      participants: [TEST_USER_ID, PEER_ID].sort(),
      lastMessageAt: new Date(1000),
      lastMessage: null,
      unreadCountByUser: {},
      mutedBy: {},
      pinnedCount: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    const res = await request(app)
      .post(`/api/chat/private/rooms/${PEER_ID}`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.data.roomId).toBe("prv_existing");
    expect(mocks.privateRoomRepo.create).not.toHaveBeenCalled();
  });
});
