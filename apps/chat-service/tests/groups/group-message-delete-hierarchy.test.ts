/**
 * Deleting SOMEONE ELSE's group message (System Messages v2 §3): groups are
 * leader + members only, so the leader (ADMIN) may delete any message and
 * nobody else may delete another member's. A leader delete posts ONE
 * MESSAGE_DELETED line {actorId, actorName, senderId, senderName, messageId};
 * an own-message delete posts none. `canDeleteOthersMessage` stays the
 * community rule.
 *
 * Route: POST /api/chat/groups/messages/delete
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";
import { canDeleteOthersMessage } from "../../src/lib/access-guard.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "grp_room_hierarchy";
const MESSAGE_BASE = "/api/chat/groups";
const MSG = "gmsg_h1";
const SENDER = "other-user-1";

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
  mocks.groupMessageRepo.findById.mockResolvedValue({
    id: MSG,
    senderId: SENDER,
    roomId: ROOM,
  });
  mocks.groupMessageRepo.deleteForEveryone.mockResolvedValue({
    id: MSG,
    roomId: ROOM,
    sequenceNumber: 7,
  });
});

/** Actor = the authenticated caller, sender = the message author. */
function programRoles(actorRole: string, senderRole: string | null): void {
  mocks.groupMemberRepo.findActiveByRoomAndUser.mockImplementation(
    async (_roomId: string, userId: string) =>
      userId === TEST_USER_ID
        ? { userId: TEST_USER_ID, role: actorRole }
        : senderRole === null
          ? null
          : { userId: SENDER, role: senderRole }
  );
}

const deleteMessage = () =>
  request(app)
    .post(`${MESSAGE_BASE}/messages/delete`)
    .set(bearer(makeAccessToken()))
    .send({ messageId: MSG, roomId: ROOM });

function systemLines(): Array<{ systemEvent: string; systemData: any }> {
  return mocks.groupMessageRepo.create.mock.calls.map(
    (c: [{ systemEvent: string; systemData: any }]) => c[0]
  );
}

describe("POST /messages/delete — leader only", () => {
  it("SECURITY: a plain MEMBER cannot delete another member's message", async () => {
    programRoles("MEMBER", "MEMBER");

    const res = await deleteMessage();

    expect(res.status).toBe(400);
    expect(mocks.groupMessageRepo.deleteForEveryone).not.toHaveBeenCalled();
  });

  it("SECURITY: a legacy MODERATOR row has no delete power", async () => {
    programRoles("MODERATOR", "MEMBER");

    const res = await deleteMessage();

    expect(res.status).toBe(400);
    expect(mocks.groupMessageRepo.deleteForEveryone).not.toHaveBeenCalled();
  });

  it("POSITIVE: the leader deletes a member's message → MESSAGE_DELETED line", async () => {
    programRoles("ADMIN", "MEMBER");
    mocks.cacheRepo.getUserSnapshots.mockResolvedValue(
      new Map([
        [TEST_USER_ID, { firstName: "An", lastName: "" }],
        [SENDER, { firstName: "Binh", lastName: "" }],
      ])
    );

    const res = await deleteMessage();

    expect(res.status).toBe(200);
    expect(mocks.groupMessageRepo.deleteForEveryone).toHaveBeenCalledWith(
      MSG,
      ROOM,
      TEST_USER_ID,
      "ADMIN_DELETE"
    );
    const lines = systemLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.systemEvent).toBe("MESSAGE_DELETED");
    expect(lines[0]!.systemData).toEqual(
      expect.objectContaining({
        actorId: TEST_USER_ID,
        actorName: expect.any(String),
        senderId: SENDER,
        senderName: expect.any(String),
        messageId: MSG,
      })
    );
  });

  it("POSITIVE: a departed sender's message is still deletable by the leader", async () => {
    programRoles("ADMIN", null);

    const res = await deleteMessage();

    expect(res.status).toBe(200);
    expect(systemLines().map((l) => l.systemEvent)).toEqual(["MESSAGE_DELETED"]);
  });

  it("NEGATIVE: deleting your own message posts no line", async () => {
    programRoles("ADMIN", "MEMBER");
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: MSG,
      senderId: TEST_USER_ID,
      roomId: ROOM,
    });

    const res = await deleteMessage();

    expect(res.status).toBe(200);
    expect(systemLines()).toHaveLength(0);
  });

  it("NEGATIVE: re-deleting an already deleted message posts no second line", async () => {
    programRoles("ADMIN", "MEMBER");
    mocks.groupMessageRepo.findById.mockResolvedValue({
      id: MSG,
      senderId: SENDER,
      roomId: ROOM,
      isDeleted: true,
    });

    await deleteMessage();

    expect(systemLines()).toHaveLength(0);
  });
});

describe("canDeleteOthersMessage (community rule)", () => {
  it("is case-insensitive, so community's lowercase live roles decide the same way", () => {
    expect(canDeleteOthersMessage("moderator", "admin")).toBe(false);
    expect(canDeleteOthersMessage("moderator", "moderator")).toBe(false);
    expect(canDeleteOthersMessage("moderator", "member")).toBe(true);
    expect(canDeleteOthersMessage("admin", "moderator")).toBe(true);
    expect(canDeleteOthersMessage("owner", "admin")).toBe(true);
    expect(canDeleteOthersMessage("member", "member")).toBe(false);
  });

  it("fails CLOSED for an unknown actor role (unreachable community-service resolves to '')", () => {
    expect(canDeleteOthersMessage("", "member")).toBe(false);
    expect(canDeleteOthersMessage(null, "member")).toBe(false);
  });

  it("treats an unknown SENDER role as a plain member (left/kicked sender)", () => {
    expect(canDeleteOthersMessage("moderator", "")).toBe(true);
    expect(canDeleteOthersMessage("moderator", undefined)).toBe(true);
  });
});
