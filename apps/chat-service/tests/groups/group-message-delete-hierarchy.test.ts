/**
 * ROLE HIERARCHY FOR DELETING SOMEONE ELSE'S MESSAGE (Issue 52).
 *
 * `GroupMessageService.deleteMessage` used to ask only "is the actor ADMIN or MODERATOR?" and
 * never looked at the SENDER's role, so a MODERATOR could delete the ADMIN's message. The rule
 * (shared with communities via `canDeleteOthersMessage`, and matching kick/mute/ban's outrank
 * check in group-member.service.ts) is:
 *
 *   ADMIN     -> may delete anyone's message
 *   MODERATOR -> may delete a plain MEMBER's message only
 *   MEMBER    -> own messages only
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

describe("POST /messages/delete — role hierarchy", () => {
  it("SECURITY: a MODERATOR cannot delete an ADMIN's message", async () => {
    programRoles("MODERATOR", "ADMIN");

    const res = await deleteMessage();

    expect(res.status).toBe(400);
    expect(mocks.groupMessageRepo.deleteForEveryone).not.toHaveBeenCalled();
  });

  it("SECURITY: a MODERATOR cannot delete a peer MODERATOR's message", async () => {
    programRoles("MODERATOR", "MODERATOR");

    const res = await deleteMessage();

    expect(res.status).toBe(400);
    expect(mocks.groupMessageRepo.deleteForEveryone).not.toHaveBeenCalled();
  });

  it("POSITIVE: a MODERATOR can delete a plain MEMBER's message", async () => {
    programRoles("MODERATOR", "MEMBER");

    const res = await deleteMessage();

    expect(res.status).toBe(200);
    expect(mocks.groupMessageRepo.deleteForEveryone).toHaveBeenCalled();
  });

  it("POSITIVE: a departed sender (no member row) ranks as MEMBER, so a MODERATOR may delete", async () => {
    programRoles("MODERATOR", null);

    const res = await deleteMessage();

    expect(res.status).toBe(200);
  });

  it("POSITIVE: an ADMIN can delete a MODERATOR's message", async () => {
    programRoles("ADMIN", "MODERATOR");

    const res = await deleteMessage();

    expect(res.status).toBe(200);
    expect(mocks.groupMessageRepo.deleteForEveryone).toHaveBeenCalled();
  });
});

describe("canDeleteOthersMessage (shared group + community rule)", () => {
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
