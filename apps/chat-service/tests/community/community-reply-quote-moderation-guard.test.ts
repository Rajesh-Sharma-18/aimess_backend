/**
 * Reply-quote hydration must not launder a restricted message into the room.
 *
 * A quote COPIES the parent's text into a message that is broadcast to every
 * member, so the parent has to be one the SENDER is allowed to read. Without the
 * gate, a plain member could reply to a MODERATION-restricted system line's id
 * (add / ban / unban / mute / unmute) — or to a message in another room — and the
 * content would come back to the whole community inside `quoteData`. That is the
 * "reply target / quoted message hydration" side door around the role gate.
 *
 * The reply itself still sends; only the quote is dropped.
 *
 * Route: POST /api/chat/community/rooms/:roomId/messages → CommunityMessageService.
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const BASE = "/api/chat/community";
const ROOM = "comm_room_1";
const COMMUNITY = "comm_1";
const PARENT_ID = "0123456789abcdef01234567";

/** The parent row the reply points at. */
function parent(over: Record<string, unknown> = {}) {
  return {
    id: PARENT_ID,
    roomId: ROOM,
    sentBy: "admin-1",
    senderId: "admin-1",
    messageType: "text",
    message: "which one?",
    isDeleted: false,
    ...over,
  };
}

/** The sender's own RoomMember row — `role` is what the gate reads. */
function asRole(role?: string) {
  mocks.roomMemberRepo.findByRoomAndUser.mockResolvedValue({
    status: "active",
    userId: TEST_USER_ID,
    ...(role ? { role } : {}),
  });
}

async function sendReply() {
  return request(app)
    .post(`${BASE}/rooms/${ROOM}/messages`)
    .set(bearer(makeAccessToken()))
    .send({
      communityId: COMMUNITY,
      messageType: "text",
      message: "what happened?",
      parentMessageId: PARENT_ID,
      clientMessageId: `cmid-${Math.random()}`,
    });
}

function createdRow(): Record<string, unknown> {
  const calls = mocks.generalRoomMessageRepo.save.mock.calls;
  return calls[calls.length - 1]![0] as Record<string, unknown>;
}

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  asRole();
  let seq = 0;
  mocks.generalRoomRepo.allocateSequenceAndRevision.mockImplementation(
    async () => ({ sequenceNumber: ++seq, revision: seq })
  );
  mocks.generalRoomMessageRepo.findByClientMessageId.mockResolvedValue(null);
  mocks.generalRoomMessageRepo.findAlbumBatchByClientMessageId.mockResolvedValue(
    []
  );
  let created = 0;
  mocks.generalRoomMessageRepo.save.mockImplementation(
    async (entity: Record<string, unknown>) => ({
      ...entity,
      id: `cmsg_${++created}`,
      createdAt: new Date(3000 + created),
    })
  );
});

describe("community reply-quote hydration honours system-message visibility", () => {
  it.each([
    "MEMBER_ADDED",
    "MEMBER_BANNED",
    "MEMBER_UNBANNED",
    "MEMBER_MUTED",
    "MEMBER_UNMUTED",
  ])(
    "drops the quote when a plain member replies to a %s line",
    async (systemMessageType) => {
      mocks.generalRoomMessageRepo.findById.mockResolvedValue(
        parent({
          messageType: "SYSTEM",
          systemMessageType,
          message: "Admin banned Bob",
          visibleToUserId: null,
        })
      );

      const res = await sendReply();

      expect([200, 201]).toContain(res.status);
      const row = createdRow();
      // The reply still sends — it just carries no copy of the restricted text.
      expect(row.quoteData).toBeUndefined();
      expect(JSON.stringify(row)).not.toContain("Admin banned Bob");
    }
  );

  it("keeps the quote when a MODERATOR replies to the same line", async () => {
    asRole("moderator");
    mocks.generalRoomMessageRepo.findById.mockResolvedValue(
      parent({
        messageType: "SYSTEM",
        systemMessageType: "MEMBER_UNBANNED",
        message: "Admin unbanned Bob",
        visibleToUserId: null,
      })
    );

    const res = await sendReply();

    expect([200, 201]).toContain(res.status);
    expect(createdRow().quoteData).toMatchObject({ messageId: PARENT_ID });
  });

  it("keeps the quote for an ordinary message and an unrelated system line", async () => {
    // The gate must not turn into "no quoting anything".
    mocks.generalRoomMessageRepo.findById.mockResolvedValue(parent());
    expect([200, 201]).toContain((await sendReply()).status);
    expect(createdRow().quoteData).toMatchObject({ messageId: PARENT_ID });

    mocks.generalRoomMessageRepo.findById.mockResolvedValue(
      parent({ messageType: "SYSTEM", systemMessageType: "ROLE_CHANGED" })
    );
    expect([200, 201]).toContain((await sendReply()).status);
    expect(createdRow().quoteData).toMatchObject({ messageId: PARENT_ID });
  });

  it("drops the quote for a parent that lives in another room (cross-room IDOR)", async () => {
    mocks.generalRoomMessageRepo.findById.mockResolvedValue(
      parent({ roomId: "some_other_room", message: "secret" })
    );

    const res = await sendReply();

    expect([200, 201]).toContain(res.status);
    expect(createdRow().quoteData).toBeUndefined();
  });

  it("keeps the quote on a member's OWN personal mute/add notice", async () => {
    // The target-addressed copy is the member's own membership notice, not a
    // moderation record about a third party, so quoting it stays allowed.
    mocks.generalRoomMessageRepo.findById.mockResolvedValue(
      parent({
        messageType: "SYSTEM",
        systemMessageType: "MEMBER_MUTED",
        visibleToUserId: TEST_USER_ID,
      })
    );

    const res = await sendReply();

    expect([200, 201]).toContain(res.status);
    expect(createdRow().quoteData).toMatchObject({ messageId: PARENT_ID });
  });
});
