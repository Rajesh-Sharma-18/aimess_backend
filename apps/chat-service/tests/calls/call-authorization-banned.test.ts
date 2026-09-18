/**
 * A platform-banned callee is refused with the same CALL_USER_UNAVAILABLE a
 * deleted one gets — friendships survive a ban, so without this gate the
 * friendship check would let the call ring.
 */
import { assertCanStartCall } from "../../src/lib/call-authorization.js";

function deps(banned: boolean) {
  return {
    friendshipRepo: {
      areFriends: jest.fn().mockResolvedValue(true),
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
    },
    privateRoomRepo: {
      findByRoomId: jest.fn(),
      findByParticipantsKey: jest.fn().mockResolvedValue({
        roomId: "prv_1",
        participants: ["smiley", "mind_flayer"],
        blockedBy: [],
      }),
    },
    getCallPrivacy: jest
      .fn()
      .mockResolvedValue({ whoCanCallMe: "FRIENDS", allowedUserIds: [] }),
    getUserSnapshot: jest.fn().mockResolvedValue({ isDeleted: false }),
    isUserBanned: jest.fn().mockResolvedValue(banned),
  };
}

describe("assertCanStartCall — platform ban", () => {
  it("refuses a banned callee as unavailable", async () => {
    await expect(
      assertCanStartCall(deps(true) as never, {
        callerId: "smiley",
        calleeId: "mind_flayer",
      })
    ).rejects.toMatchObject({ message: "CALL_USER_UNAVAILABLE" });
  });

  it("still allows a call to an available friend", async () => {
    await expect(
      assertCanStartCall(deps(false) as never, {
        callerId: "smiley",
        calleeId: "mind_flayer",
      })
    ).resolves.toMatchObject({ room: { roomId: "prv_1" } });
  });
});
