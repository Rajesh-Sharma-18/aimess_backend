/**
 * "Delete Conversation" for a group — DELETE /api/chat/groups/:roomId.
 *
 * WhatsApp semantics: the caller's own list row goes away (a `clearedAt`
 * cutoff), the GROUP itself is untouched — no membership change, no disband,
 * nothing written for any other member. It is allowed for LEFT/KICKED members
 * too, because their read-only row is still in their conversation list and
 * deleting it is what finally takes the group out of their search results
 * (see the gRPC `searchUserGroups` visibility rule).
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken, TEST_USER_ID } from "../helpers/auth.js";

const ROOM = "grp_room_1";

let app: import("express").Express;
let mocks: BuiltMocks;

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.cacheRepo.getUserSnapshots.mockResolvedValue(new Map());
});

const del = () =>
  request(app)
    .delete(`/api/chat/groups/${ROOM}`)
    .set(bearer(makeAccessToken()));

function member(status: string) {
  mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue({
    roomId: ROOM,
    userId: TEST_USER_ID,
    status,
    role: "MEMBER",
  });
}

describe("DELETE /api/chat/groups/:roomId (delete conversation)", () => {
  it("POSITIVE: an ACTIVE member clears their own history, membership intact", async () => {
    member("ACTIVE");
    const res = await del();
    expect(res.status).toBe(200);
    expect(mocks.groupMemberRepo.setClearedAt).toHaveBeenCalledWith(
      ROOM,
      TEST_USER_ID
    );
    // The group survives: no membership transition, no disband, no member-count
    // write — nothing that would touch another member's list.
    expect(mocks.groupMemberRepo.updateStatus).not.toHaveBeenCalled();
    expect(mocks.groupRoomRepo.disband).not.toHaveBeenCalled();
    expect(mocks.groupRoomRepo.incMemberCount).not.toHaveBeenCalled();
  });

  it.each(["LEFT", "KICKED"])(
    "POSITIVE: a %s member can delete their read-only row",
    async (status) => {
      member(status);
      const res = await del();
      expect(res.status).toBe(200);
      expect(mocks.groupMemberRepo.setClearedAt).toHaveBeenCalledWith(
        ROOM,
        TEST_USER_ID
      );
      expect(mocks.groupMemberRepo.updateStatus).not.toHaveBeenCalled();
    }
  );

  it("NEGATIVE: 404 for a BANNED member — the inbox never lists that row", async () => {
    member("BANNED");
    const res = await del();
    expect(res.status).toBe(404);
    expect(mocks.groupMemberRepo.setClearedAt).not.toHaveBeenCalled();
  });

  it("NEGATIVE: 404 for a non-member", async () => {
    mocks.groupMemberRepo.findByRoomAndUser.mockResolvedValue(null);
    const res = await del();
    expect(res.status).toBe(404);
    expect(mocks.groupMemberRepo.setClearedAt).not.toHaveBeenCalled();
  });
});
