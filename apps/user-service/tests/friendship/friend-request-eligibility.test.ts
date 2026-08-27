/**
 * `canSendFriendRequest` — the ONE decision every add-friend affordance reads.
 *
 * User search, discovery, the public profile, the private-chat peer and the
 * gRPC relationship map all call this function, and `friendshipService
 * .sendRequest` enforces the same `scopeAdmits` primitive on the write side.
 * If this table is right, no surface can offer an action the API refuses.
 *
 * Mirrors the required privacy × relationship matrix.
 */
import {
  canSendFriendRequest,
  type FriendRequestContext,
} from "../../src/lib/privacy-scope.js";

const withScope = (scope: string | null) => ({
  privacySettings: { whoCanSendFriendRequests: scope },
});

const STRANGER = { isFriend: false, isFriendOfFriend: false };
const MUTUAL_FRIEND = { isFriend: false, isFriendOfFriend: true };
const FRIEND = { isFriend: true, isFriendOfFriend: true };

const NONE: FriendRequestContext = { status: "NONE" };

describe("canSendFriendRequest — privacy × relationship matrix", () => {
  describe("whoCanSendFriendRequests = NO_ONE", () => {
    it("refuses a stranger", () => {
      expect(canSendFriendRequest(withScope("NO_ONE"), STRANGER, NONE)).toBe(
        false
      );
    });

    it("refuses a friend-of-friend — NO_ONE admits nobody, not even one hop", () => {
      expect(
        canSendFriendRequest(withScope("NO_ONE"), MUTUAL_FRIEND, NONE)
      ).toBe(false);
    });

    it("refuses an existing friend (there is nothing left to request)", () => {
      expect(
        canSendFriendRequest(withScope("NO_ONE"), FRIEND, { status: "FRIEND" })
      ).toBe(false);
    });
  });

  describe("whoCanSendFriendRequests = FRIENDS", () => {
    it("refuses a stranger", () => {
      expect(canSendFriendRequest(withScope("FRIENDS"), STRANGER, NONE)).toBe(
        false
      );
    });

    it("refuses a friend-of-friend — FRIENDS is one hop narrower", () => {
      expect(
        canSendFriendRequest(withScope("FRIENDS"), MUTUAL_FRIEND, NONE)
      ).toBe(false);
    });
  });

  describe("whoCanSendFriendRequests = FRIENDS_OF_FRIENDS", () => {
    it("refuses a stranger with no mutual friend", () => {
      expect(
        canSendFriendRequest(withScope("FRIENDS_OF_FRIENDS"), STRANGER, NONE)
      ).toBe(false);
    });

    it("admits a viewer sharing at least one mutual friend", () => {
      expect(
        canSendFriendRequest(
          withScope("FRIENDS_OF_FRIENDS"),
          MUTUAL_FRIEND,
          NONE
        )
      ).toBe(true);
    });
  });

  describe("whoCanSendFriendRequests = EVERYONE (and unset)", () => {
    it("admits a stranger", () => {
      expect(canSendFriendRequest(withScope("EVERYONE"), STRANGER, NONE)).toBe(
        true
      );
    });

    it("admits a stranger when the settings row is missing (schema default)", () => {
      expect(canSendFriendRequest({}, STRANGER, NONE)).toBe(true);
      expect(canSendFriendRequest(withScope(null), STRANGER, NONE)).toBe(true);
    });
  });

  describe("preconditions that override the scope entirely", () => {
    it.each(["EVERYONE", "FRIENDS_OF_FRIENDS", "FRIENDS", "NO_ONE"])(
      "self never gets an add action (scope %s)",
      (scope) => {
        expect(
          canSendFriendRequest(
            withScope(scope),
            { isSelf: true, isFriend: false },
            NONE
          )
        ).toBe(false);
      }
    );

    it("a block in EITHER direction refuses even under EVERYONE", () => {
      expect(
        canSendFriendRequest(withScope("EVERYONE"), STRANGER, {
          status: "NONE",
          isBlockedEitherWay: true,
        })
      ).toBe(false);
      expect(
        canSendFriendRequest(withScope("EVERYONE"), STRANGER, {
          status: "BLOCKED",
        })
      ).toBe(false);
    });

    it("an outstanding request is answered or withdrawn, never re-sent", () => {
      // Both directions: OUTGOING is `canCancel`, INCOMING is `canAccept`.
      expect(
        canSendFriendRequest(withScope("EVERYONE"), STRANGER, {
          status: "PENDING",
        })
      ).toBe(false);
      // Even NO_ONE — the addressee's own outgoing request stays acceptable,
      // which the write path exempts as a mutual accept, not as a new send.
      expect(
        canSendFriendRequest(withScope("NO_ONE"), STRANGER, {
          status: "PENDING",
        })
      ).toBe(false);
    });

    it("an existing friendship refuses under every scope", () => {
      for (const scope of ["EVERYONE", "FRIENDS_OF_FRIENDS", "FRIENDS"]) {
        expect(
          canSendFriendRequest(withScope(scope), FRIEND, { status: "FRIEND" })
        ).toBe(false);
      }
    });
  });

  it("never leaks WHY it refused — the answer is a bare boolean", () => {
    // NO_ONE, a block, and an unsatisfied FRIENDS scope are indistinguishable
    // to the caller, which is what stops the flag being used to probe someone's
    // privacy or block state.
    const denials = [
      canSendFriendRequest(withScope("NO_ONE"), STRANGER, NONE),
      canSendFriendRequest(withScope("FRIENDS"), STRANGER, NONE),
      canSendFriendRequest(withScope("EVERYONE"), STRANGER, {
        status: "NONE",
        isBlockedEitherWay: true,
      }),
    ];
    expect(denials).toEqual([false, false, false]);
  });
});
