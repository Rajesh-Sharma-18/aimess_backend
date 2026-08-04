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
  visibleIsOnline,
} from "../../src/lib/privacy-scope.js";

const FRIEND = "friend-id";

describe("scopeAdmits", () => {
  it("lets self through regardless of scope", () => {
    expect(scopeAdmits("NO_ONE", true, false)).toBe(true);
  });

  it("denies everyone but self under NO_ONE", () => {
    expect(scopeAdmits("NO_ONE", false, true)).toBe(false);
    expect(scopeAdmits("NO_ONE", false, false)).toBe(false);
  });

  it("admits only friends under FRIENDS", () => {
    expect(scopeAdmits("FRIENDS", false, true)).toBe(true);
    expect(scopeAdmits("FRIENDS", false, false)).toBe(false);
  });

  // Documented over-restriction: the mutual-friend graph query does not exist
  // yet, so FoF collapses to FRIENDS. Update this expectation together with
  // scopeAdmits when that query lands — never loosen one without the other.
  it("treats FRIENDS_OF_FRIENDS as FRIENDS for now", () => {
    expect(scopeAdmits("FRIENDS_OF_FRIENDS", false, true)).toBe(true);
    expect(scopeAdmits("FRIENDS_OF_FRIENDS", false, false)).toBe(false);
  });

  it("falls back to EVERYONE for an unset scope", () => {
    expect(scopeAdmits(undefined, false, false)).toBe(true);
    expect(scopeAdmits(null, false, false)).toBe(true);
    expect(scopeAdmits("EVERYONE", false, false)).toBe(true);
  });
});

describe("discoverableWhere", () => {
  const where = discoverableWhere([FRIEND]);

  it("admits EVERYONE and users with no settings row, for any viewer", () => {
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { privacySettings: { is: null } },
        { privacySettings: { whoCanFindMe: "EVERYONE" } },
      ])
    );
  });

  it("restricts friend-scoped rows to the viewer's friend ids", () => {
    expect(where.OR).toEqual(
      expect.arrayContaining([
        {
          privacySettings: {
            whoCanFindMe: { in: ["FRIENDS", "FRIENDS_OF_FRIENDS"] },
          },
          userId: { in: [FRIEND] },
        },
      ])
    );
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
    expect(visibleIsOnline(online("NO_ONE"), true)).toBe(false);
    expect(visibleIsOnline(online("FRIENDS"), false)).toBe(false);
  });

  it("passes real presence to an admitted viewer", () => {
    expect(visibleIsOnline(online("FRIENDS"), true)).toBe(true);
    expect(visibleIsOnline(online("EVERYONE"), false)).toBe(true);
  });

  // Regression: the generic scopeAdmits fallback is EVERYONE, but the schema
  // default for whoCanSeeOnlineStatus is FRIENDS. A profile with no settings
  // row must NOT expose presence to strangers just because the row is absent.
  it("falls back to FRIENDS (not EVERYONE) when the settings row is missing", () => {
    expect(SCHEMA_DEFAULT_SCOPE.whoCanSeeOnlineStatus).toBe("FRIENDS");
    expect(visibleIsOnline({ isOnline: true }, false)).toBe(false);
    expect(visibleIsOnline({ isOnline: true }, true)).toBe(true);
    expect(visibleIsOnline(online(null), false)).toBe(false);
  });

  it("still falls back to EVERYONE for profile visibility", () => {
    expect(SCHEMA_DEFAULT_SCOPE.whoCanViewProfile).toBe("EVERYONE");
    expect(canViewProfile({}, false)).toBe(true);
  });

  it("gates profile fields on whoCanViewProfile independently of presence", () => {
    const p = { privacySettings: { whoCanViewProfile: "FRIENDS" } };
    expect(canViewProfile(p, true)).toBe(true);
    expect(canViewProfile(p, false)).toBe(false);
  });
});
