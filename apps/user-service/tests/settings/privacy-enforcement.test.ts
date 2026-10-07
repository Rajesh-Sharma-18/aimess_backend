/**
 * Privacy-scope enforcement — the shared predicates every surface routes
 * through (`src/lib/privacy-scope.ts`). These are pure functions, so they are
 * tested directly rather than through HTTP; the per-surface wiring that calls
 * them is covered by user-search / user-discovery / friendship suites.
 */
import {
  SCHEMA_DEFAULT_SCOPE,
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

  it("admits accepted friends under every scope, NO_ONE included", () => {
    expect(where.OR).toEqual(
      expect.arrayContaining([{ userId: { in: [FRIEND] } }])
    );
  });

  it("admits FRIENDS_OF_FRIENDS rows for the one-hop expansion", () => {
    expect(where.OR).toEqual(
      expect.arrayContaining([
        {
          privacySettings: { whoCanFindMe: "FRIENDS_OF_FRIENDS" },
          userId: { in: [FOF] },
        },
      ])
    );
  });

  it("hides NO_ONE from non-friends: no scope branch names it", () => {
    expect(JSON.stringify(where)).not.toContain("NO_ONE");
    expect(JSON.stringify(where)).not.toContain(`"in":["${'${FOF}'}"]},{`);
  });
});

describe("discoverableWhere — blocks", () => {
  it("excludes users who blocked the viewer, even friends and chat peers", () => {
    const where = discoverableWhere(
      { friendIds: ["b"], friendOfFriendIds: [], blockerIds: ["b"] },
      ["b"]
    );
    expect(where).toEqual({
      AND: [expect.anything(), { userId: { notIn: ["b"] } }],
    });
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

  it("has no whoCanViewProfile scope any more", () => {
    expect(SCHEMA_DEFAULT_SCOPE).not.toHaveProperty("whoCanViewProfile");
  });
});

describe("visibleIdentity — name + avatar on profile-card surfaces", () => {
  const named = { firstName: "Ada", lastName: "Lovelace" };
  const scoped = (whoCanViewProfile: string | null) => ({
    ...named,
    privacySettings: { whoCanViewProfile },
  });

  // Identity is NOT viewer-scoped: a search hit that degrades to a bare handle
  // is unusable to the very stranger `whoCanFindMe` let through, so the scope
  // gates the profile CONTENT (bio/cover/counts/presence) and never the name
  // or the photo. Friend and stranger must see the identical identity.
  it("returns the real name and allows the avatar for a stranger", () => {
    expect(visibleIdentity(scoped("EVERYONE"))).toEqual({
      avatarAllowed: true,
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
    });
  });

  it("keeps name and avatar even under NO_ONE — that scope gates content", () => {
    expect(visibleIdentity(scoped("NO_ONE"))).toEqual({
      avatarAllowed: true,
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
    });
  });

  it("renders identically for a friend and for a stranger", () => {
    expect(visibleIdentity(scoped("FRIENDS"))).toEqual(
      visibleIdentity(scoped("EVERYONE"))
    );
  });

  it("no settings row still yields the real name", () => {
    expect(visibleIdentity(named).fullName).toBe("Ada Lovelace");
  });

  it("anonymize blanks name and avatar — the deleted-account case", () => {
    expect(visibleIdentity(named, { anonymize: true })).toEqual({
      avatarAllowed: false,
      firstName: null,
      lastName: null,
      fullName: null,
    });
  });
});
