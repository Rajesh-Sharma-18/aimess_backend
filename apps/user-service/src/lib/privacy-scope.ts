/**
 * Viewer-relative privacy evaluation — the ONE place every `PrivacyScope`
 * decision is made. Search, discovery, profile reads, friend requests and the
 * presence gRPC gate all route through here so a scope can never be enforced
 * on one surface and forgotten on another.
 *
 * `FRIENDS_OF_FRIENDS` is deliberately evaluated as `FRIENDS`: the mutual-friend
 * graph query does not exist yet, and over-restricting is the safe failure. When
 * that query lands, only `scopeAdmits` changes.
 */
import type { Prisma } from "../generated/prisma/client.js";

/** Scopes that admit friends but not strangers. */
const FRIEND_SCOPES = ["FRIENDS", "FRIENDS_OF_FRIENDS"] as const;

/**
 * Per-field fallback when a user has NO `privacy_settings` row.
 *
 * These MUST mirror the `@default(...)` values in `prisma/schema.prisma` — they
 * are not all `EVERYONE`. Presence and calls default to `FRIENDS`, so a blanket
 * "unset means public" fallback would expose online status to strangers for any
 * profile whose settings row is missing. (`findCallPrivacy` already defaults to
 * `FRIENDS` for exactly this reason; this keeps the rest consistent with it.)
 *
 * Profile creation writes all five settings rows in one transaction, so an
 * absent row is defensive-only today — but the default has to be safe anyway.
 */
export const SCHEMA_DEFAULT_SCOPE = {
  whoCanFindMe: "EVERYONE",
  whoCanSendFriendRequests: "EVERYONE",
  whoCanSeeOnlineStatus: "FRIENDS",
  whoCanViewProfile: "EVERYONE",
} as const;

/**
 * Does `scope` let this viewer through? Self always passes.
 *
 * An absent scope falls through to `EVERYONE`. Callers whose field defaults to
 * something stricter MUST pass the fallback explicitly — use
 * `SCHEMA_DEFAULT_SCOPE`, or the `visibleIsOnline` / `canViewProfile` helpers
 * below, which already do.
 */
export function scopeAdmits(
  scope: string | null | undefined,
  isSelf: boolean,
  isFriend: boolean
): boolean {
  if (isSelf) return true;
  switch (scope) {
    case "NO_ONE":
      return false;
    case "FRIENDS":
    case "FRIENDS_OF_FRIENDS":
      return isFriend;
    default:
      return true; // EVERYONE, or unset
  }
}

/**
 * Prisma `where` fragment restricting a UserProfile query to rows the viewer is
 * allowed to DISCOVER (`whoCanFindMe`). Merge into any search/listing query:
 *
 *   where: { ...searchFilter, ...discoverableWhere(viewerFriendIds) }
 *
 * `NO_ONE` rows are excluded for everyone (including friends), matching the
 * "should not appear in search results for anyone" rule. Rows with no
 * `privacySettings` row yet are treated as `EVERYONE` (the schema default), so
 * this never hides users who have simply never opened Settings.
 *
 * The viewer's OWN row is not special-cased here — callers already exclude
 * self, and a user searching for themself is not a discovery decision.
 */
export function discoverableWhere(
  viewerFriendIds: string[]
): Prisma.UserProfileWhereInput {
  return {
    OR: [
      { privacySettings: { is: null } },
      { privacySettings: { whoCanFindMe: "EVERYONE" } },
      {
        privacySettings: { whoCanFindMe: { in: [...FRIEND_SCOPES] } },
        userId: { in: viewerFriendIds },
      },
    ],
  };
}

/** Prisma select fragment pulling the scopes list surfaces need to mask by. */
export const PRIVACY_SCOPE_SELECT = {
  select: { whoCanSeeOnlineStatus: true, whoCanViewProfile: true },
} as const;

type ScopeCarrier = {
  privacySettings?: {
    whoCanSeeOnlineStatus?: string | null;
    whoCanViewProfile?: string | null;
  } | null;
};

/**
 * `isOnline` as this viewer is allowed to see it. List surfaces (search,
 * discovery, member pickers) carry a boolean rather than the profile card's
 * nullable presence, so a denied viewer sees `false` — indistinguishable from
 * a genuinely offline user, which is the point.
 */
export function visibleIsOnline(
  profile: ScopeCarrier & { isOnline: boolean },
  isFriend: boolean
): boolean {
  return scopeAdmits(
    profile.privacySettings?.whoCanSeeOnlineStatus ??
      SCHEMA_DEFAULT_SCOPE.whoCanSeeOnlineStatus,
    false,
    isFriend
  )
    ? profile.isOnline
    : false;
}

/** Does this viewer get the gated profile fields (bio, cover, counts)? */
export function canViewProfile(
  profile: ScopeCarrier,
  isFriend: boolean
): boolean {
  return scopeAdmits(
    profile.privacySettings?.whoCanViewProfile ??
      SCHEMA_DEFAULT_SCOPE.whoCanViewProfile,
    false,
    isFriend
  );
}
