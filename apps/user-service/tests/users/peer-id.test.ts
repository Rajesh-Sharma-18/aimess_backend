import { isUserId, onlyUuidPeers } from "../../src/lib/peer-id.js";

// Regression: a chat-service private room whose `participants` array holds a
// non-uuid string ("undefined", a `grp_` room id, a garbled uuid) put that
// string into the `UserProfile.userId` (@db.Uuid) filter of
// `findUsersNotInList`, so Postgres answered 22P02 → Prisma P2007 → the whole
// GET /api/v1/users/search failed with a generic 400 REQUEST_FAILED.
describe("peer-id guard", () => {
  const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("accepts a uuid", () => {
    expect(isUserId(UUID)).toBe(true);
    expect(isUserId(UUID.toUpperCase())).toBe(true);
  });

  it("rejects every non-uuid id seen in corrupt private rooms", () => {
    for (const bad of [
      "undefined",
      "grp_PWSESsGxqhS3kUDh",
      `${UUID}2515`,
      "232322323232",
      "",
      null,
      undefined,
    ]) {
      expect(isUserId(bad)).toBe(false);
    }
  });

  it("keeps only uuid peers, preserving their roomId", () => {
    expect(
      onlyUuidPeers([
        { peerUserId: "undefined", roomId: "prv_a" },
        { peerUserId: UUID, roomId: "prv_b" },
        { peerUserId: "grp_x", roomId: "prv_c" },
      ])
    ).toEqual([{ peerUserId: UUID, roomId: "prv_b" }]);
  });
});
