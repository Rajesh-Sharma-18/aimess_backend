/**
 * Privacy-scope enforcement — the shared predicates every surface routes
 * through (`src/lib/privacy-scope.ts`). These are pure functions, so they are
 * tested directly rather than through HTTP; the per-surface wiring that calls
 * them is covered by user-search / user-discovery / friendship suites.
 */
import {
  SCHEMA_DEFAULT_SCOPE,
  canViewProfile,
  discoverableWhere,
  scopeAdmits,
  visibleIdentity,
  visibleIsOnline,
} from "../../src/lib/privacy-scope.js";

const FRIEND = "friend-id";
const FOF = "friend-of-friend-id";

const stranger = { isFriend: false };
const friend = { isFriend: true };
const friendOfFriend = { isFriend: false, isFriendOfFriend: true };

describe("scopeAdmits", () => {
  it("lets self through regardless of scope", () => {
    expect(scopeAdmits("NO_ONE", { isSelf: true, isFriend: false })).toBe(true);
  });

  it("denies everyone but self under NO_ONE", () => {
    expect(scopeAdmits("NO_ONE", friend)).toBe(false);
    expect(scopeAdmits("NO_ONE", stranger)).toBe(false);
    expect(scopeAdmits("NO_ONE", friendOfFriend)).toBe(false);
  });

  it("admits only direct friends under FRIENDS", () => {
    expect(scopeAdmits("FRIENDS", friend)).toBe(true);
    expect(scopeAdmits("FRIENDS", stranger)).toBe(false);
    // A mutual friend is NOT a direct friend — FRIENDS must not widen to FoF.
    expect(scopeAdmits("FRIENDS", friendOfFriend)).toBe(false);
  });

  describe("FRIENDS_OF_FRIENDS", () => {
    it("admits a user sharing at least one mutual friend (A↔B↔C)", () => {
      expect(scopeAdmits("FRIENDS_OF_FRIENDS", friendOfFriend)).toBe(true);
    });

    it("admits direct friends too — it widens FRIENDS, never narrows it", () => {
      expect(scopeAdmits("FRIENDS_OF_FRIENDS", friend)).toBe(true);
    });

    it("denies a stranger with no mutual friend (A↔B↔C↔D is not FoF)", () => {
      expect(scopeAdmits("FRIENDS_OF_FRIENDS", stranger)).toBe(false);
    });

    it("denies when the caller never resolved the graph (fails closed)", () => {
      // Omitting isFriendOfFriend must over-restrict, never over-share.
      expect(scopeAdmits("FRIENDS_OF_FRIENDS", { isFriend: false })).toBe(
        false
      );
    });
  });

  it("falls back to EVERYONE for an unset scope", () => {
    expect(scopeAdmits(undefined, stranger)).toBe(true);
    expect(scopeAdmits(null, stranger)).toBe(true);
    expect(scopeAdmits("EVERYONE", stranger)).toBe(true);
  });
});

describe("discoverableWhere", () => {
  const where = discoverableWhere({
    friendIds: [FRIEND],
    friendOfFriendIds: [FOF],
  });

  it("admits EVERYONE and users with no settings row, for any viewer", () => {
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { privacySettings: { is: null } },
        { privacySettings: { whoCanFindMe: "EVERYONE" } },
      ])
    );
  });

  it("restricts FRIENDS rows to direct friends only", () => {
    expect(where.OR).toEqual(
      expect.arrayContaining([
        {
          privacySettings: { whoCanFindMe: "FRIENDS" },
          userId: { in: [FRIEND] },
        },
      ])
    );
  });

  it("widens FRIENDS_OF_FRIENDS rows to friends AND their one-hop expansion", () => {
    expect(where.OR).toEqual(
      expect.arrayContaining([
        {
          privacySettings: { whoCanFindMe: "FRIENDS_OF_FRIENDS" },
          userId: { in: [FRIEND, FOF] },
        },
      ])
    );
  });

  it("never puts a friend-of-friend into the FRIENDS branch", () => {
    const friendsBranch = where.OR?.find(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        "privacySettings" in b &&
        (b as { privacySettings?: { whoCanFindMe?: string } }).privacySettings
          ?.whoCanFindMe === "FRIENDS"
    ) as { userId?: { in?: string[] } } | undefined;
    expect(friendsBranch?.userId?.in).not.toContain(FOF);
  });

  it("has no branch that can match NO_ONE — it is unsearchable by anyone", () => {
    expect(JSON.stringify(where)).not.toContain("NO_ONE");
  });
});

describe("presence + profile masking on list surfaces", () => {
  const online = (scope: string | null) => ({
    isOnline: true,
    privacySettings: { whoCanSeeOnlineStatus: scope },
  });

  it("reports a denied viewer `false`, not null — offline is the cover story", () => {
    expect(visibleIsOnline(online("NO_ONE"), friend)).toBe(false);
    expect(visibleIsOnline(online("FRIENDS"), stranger)).toBe(false);
  });

  it("passes real presence to an admitted viewer", () => {
    expect(visibleIsOnline(online("FRIENDS"), friend)).toBe(true);
    expect(visibleIsOnline(online("EVERYONE"), stranger)).toBe(true);
  });

  // Regression: the generic scopeAdmits fallback is EVERYONE, but the schema
  // default for whoCanSeeOnlineStatus is FRIENDS. A profile with no settings
  // row must NOT expose presence to strangers just because the row is absent.
  it("falls back to FRIENDS (not EVERYONE) when the settings row is missing", () => {
    expect(SCHEMA_DEFAULT_SCOPE.whoCanSeeOnlineStatus).toBe("FRIENDS");
    expect(visibleIsOnline({ isOnline: true }, stranger)).toBe(false);
    expect(visibleIsOnline({ isOnline: true }, friend)).toBe(true);
    expect(visibleIsOnline(online(null), stranger)).toBe(false);
  });

  it("still falls back to EVERYONE for profile visibility", () => {
    expect(SCHEMA_DEFAULT_SCOPE.whoCanViewProfile).toBe("EVERYONE");
    expect(canViewProfile({}, stranger)).toBe(true);
  });

  it("gates profile fields on whoCanViewProfile independently of presence", () => {
    const p = { privacySettings: { whoCanViewProfile: "FRIENDS" } };
    expect(canViewProfile(p, friend)).toBe(true);
    expect(canViewProfile(p, stranger)).toBe(false);
  });

  it("admits a friend-of-friend to a FRIENDS_OF_FRIENDS profile", () => {
    const p = { privacySettings: { whoCanViewProfile: "FRIENDS_OF_FRIENDS" } };
    expect(canViewProfile(p, friendOfFriend)).toBe(true);
    expect(canViewProfile(p, stranger)).toBe(false);
  });
});

describe("visibleIdentity — name + avatar on profile-card surfaces", () => {
  const named = { firstName: "Ada", lastName: "Lovelace" };
  const scoped = (whoCanViewProfile: string | null) => ({
    ...named,
    privacySettings: { whoCanViewProfile },
  });

  it("returns the real name and allows the avatar when the scope admits", () => {
    expect(visibleIdentity(scoped("EVERYONE"), stranger)).toEqual({
      avatarAllowed: true,
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
    });
  });

  it("NO_ONE hides the name AND the avatar, even from a friend", () => {
    expect(visibleIdentity(scoped("NO_ONE"), friend)).toEqual({
      avatarAllowed: false,
      firstName: null,
      lastName: null,
      fullName: null,
    });
  });

  it("FRIENDS hides both from a stranger and shows both to a friend", () => {
    expect(visibleIdentity(scoped("FRIENDS"), stranger).fullName).toBeNull();
    expect(visibleIdentity(scoped("FRIENDS"), stranger).avatarAllowed).toBe(
      false
    );
    expect(visibleIdentity(scoped("FRIENDS"), friend).fullName).toBe(
      "Ada Lovelace"
    );
  });

  it("FRIENDS_OF_FRIENDS admits one hop but not a stranger", () => {
    expect(
      visibleIdentity(scoped("FRIENDS_OF_FRIENDS"), friendOfFriend).fullName
    ).toBe("Ada Lovelace");
    expect(
      visibleIdentity(scoped("FRIENDS_OF_FRIENDS"), stranger).fullName
    ).toBeNull();
  });

  it("the owner always sees their own name", () => {
    expect(
      visibleIdentity(scoped("NO_ONE"), { isSelf: true, isFriend: false })
        .fullName
    ).toBe("Ada Lovelace");
  });

  it("no settings row falls back to EVERYONE, not to hidden", () => {
    expect(visibleIdentity(named, stranger).fullName).toBe("Ada Lovelace");
  });
});
