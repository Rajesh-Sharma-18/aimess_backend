/**
 * Viewer-relative privacy evaluation — the ONE place every `PrivacyScope`
 * decision is made. Search, discovery, profile reads, friend requests and the
 * presence gRPC gate all route through here so a scope can never be enforced
 * on one surface and forgotten on another.
 *
 * `FRIENDS_OF_FRIENDS` means EXACTLY ONE hop past a direct friend: the viewer
 * and the target must share at least one mutual friend (A↔B↔C admits C to A).
 * Two hops (A↔B↔C↔D) is NOT friend-of-friend. Direct friends also satisfy it —
 * the scope widens `FRIENDS`, it does not replace it.
 */
import type { Prisma } from "../generated/prisma/client.js";

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
 * How the viewer is related to the profile being evaluated.
 *
 * `isFriendOfFriend` defaults to false so a caller that has not resolved the
 * mutual-friend graph over-restricts rather than over-shares. Every surface
 * where `FRIENDS_OF_FRIENDS` is a selectable option MUST pass it — search,
 * friend requests and profile reads all do.
 */
export type ViewerRelation = {
  isSelf?: boolean;
  /** Direct ACCEPTED friendship with the viewer. */
  isFriend: boolean;
  /** At least one mutual friend. Only consulted for `FRIENDS_OF_FRIENDS`. */
  isFriendOfFriend?: boolean;
};

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
  relation: ViewerRelation
): boolean {
  if (relation.isSelf) return true;
  switch (scope) {
    case "NO_ONE":
      return false;
    case "FRIENDS":
      return relation.isFriend;
    // A direct friend trivially shares the friendship edge, so FRIENDS_OF_FRIENDS
    // admits them too — it is strictly wider than FRIENDS, never narrower.
    case "FRIENDS_OF_FRIENDS":
      return relation.isFriend || relation.isFriendOfFriend === true;
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
 *
 * `friendOfFriendIds` is the pre-resolved one-hop expansion of the viewer's
 * friend list (see `friendshipRepository.findFriendsOfFriendIds`). It is passed
 * in rather than resolved here because a Prisma `where` fragment cannot express
 * a graph traversal — and because the same set is reused to mask profile fields
 * on the rows that come back, so it costs one query per request, not per row.
 */
export type ViewerGraph = {
  friendIds: string[];
  /** One-hop expansion of `friendIds`, excluding self and direct friends. */
  friendOfFriendIds: string[];
};

export function discoverableWhere(
  viewer: ViewerGraph
): Prisma.UserProfileWhereInput {
  return {
    OR: [
      { privacySettings: { is: null } },
      { privacySettings: { whoCanFindMe: "EVERYONE" } },
      {
        privacySettings: { whoCanFindMe: "FRIENDS" },
        userId: { in: viewer.friendIds },
      },
      {
        privacySettings: { whoCanFindMe: "FRIENDS_OF_FRIENDS" },
        // Direct friends qualify too — FoF widens FRIENDS, never narrows it.
        userId: { in: [...viewer.friendIds, ...viewer.friendOfFriendIds] },
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
  relation: ViewerRelation
): boolean {
  // `whoCanSeeOnlineStatus` has no FRIENDS_OF_FRIENDS option (see
  // settings.validator.ts), so presence never consults the mutual-friend graph.
  return scopeAdmits(
    profile.privacySettings?.whoCanSeeOnlineStatus ??
      SCHEMA_DEFAULT_SCOPE.whoCanSeeOnlineStatus,
    relation
  )
    ? profile.isOnline
    : false;
}

/** Does this viewer get the gated profile fields (bio, cover, counts)? */
export function canViewProfile(
  profile: ScopeCarrier,
  relation: ViewerRelation
): boolean {
  return scopeAdmits(
    profile.privacySettings?.whoCanViewProfile ??
      SCHEMA_DEFAULT_SCOPE.whoCanViewProfile,
    relation
  );
}

/**
 * Real name + avatar as this viewer may see them, for the surfaces that serve a
 * PROFILE CARD: the profile endpoint, search results, discovery lists and
 * recent searches. `NO_ONE` there means "only the owner sees the complete
 * profile", and a name and photo are the most identifying parts of it — masking
 * only bio/cover/counts left the card recognizable, which is the whole thing
 * the setting is meant to prevent.
 *
 * `userId` and `username` deliberately survive: the row must stay actionable
 * (send a request, block, open the chat) and the handle is already public
 * everywhere the user is addressable. Presence is masked separately by
 * {@link visibleIsOnline} — it has its own scope.
 *
 * NOT applied to conversation surfaces (chat headers, group/community member
 * lists, mentions, message senders). Those show who you are already talking to,
 * and blanking them would render existing chats nameless rather than private.
 * See `avatarAllowed` for the avatar: call sites resolve the stored key through
 * their own media resolver with `null` so a denied viewer gets the identical
 * "no avatar" shape as a user who never set one.
 */
export function visibleIdentity(
  profile: ScopeCarrier & { firstName: string; lastName: string },
  relation: ViewerRelation
): {
  avatarAllowed: boolean;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
} {
  const allowed = canViewProfile(profile, relation);
  return {
    avatarAllowed: allowed,
    firstName: allowed ? profile.firstName : null,
    lastName: allowed ? profile.lastName : null,
    fullName: allowed
      ? `${profile.firstName} ${profile.lastName}`.trim()
      : null,
  };
}
