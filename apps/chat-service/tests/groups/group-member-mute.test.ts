/**
 * System Messages v2 §3 — groups are leader + members only. Member ban/unban,
 * moderation mute/unmute and the muted roster were removed: every route
 * answers 410 CHAT_GROUP_FEATURE_REMOVED and writes nothing.
 */
import request from "supertest";

import { buildApp, type BuiltMocks } from "../helpers/app-factory.js";
import { bearer, makeAccessToken } from "../helpers/auth.js";

let app: import("express").Express;
let mocks: BuiltMocks;

const ROOM = "grp_room_mute";
const BODY = { roomId: ROOM, userId: "target-user-1" };

beforeEach(() => {
  ({ app, mocks } = buildApp());
  mocks.groupMemberRepo.findActiveByRoomAndUser.mockResolvedValue({
    role: "ADMIN",
  });
});

describe("removed group moderation routes → 410", () => {
  it.each(["ban", "unban", "mute-member", "unmute-member"])(
    "POST /group-members/%s",
    async (path) => {
      const res = await request(app)
        .post(`/api/chat/group-members/${path}`)
        .set(bearer(makeAccessToken()))
        .send(BODY);

      expect(res.status).toBe(410);
      expect(res.body.code).toBe("CHAT_GROUP_FEATURE_REMOVED");
      expect(mocks.groupMemberRepo.updateStatus).not.toHaveBeenCalled();
      expect(mocks.redis.publish).not.toHaveBeenCalled();
    }
  );

  it("GET /group-members/:roomId/muted", async () => {
    const res = await request(app)
      .get(`/api/chat/group-members/${ROOM}/muted`)
      .set(bearer(makeAccessToken()));

    expect(res.status).toBe(410);
    expect(res.body.code).toBe("CHAT_GROUP_FEATURE_REMOVED");
  });

  it("still requires auth", async () => {
    const res = await request(app)
      .post("/api/chat/group-members/ban")
      .send(BODY);

    expect(res.status).toBe(401);
  });
});
