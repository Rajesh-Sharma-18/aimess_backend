/** Socket-level DTOs for community real-time events (community-service → gateway → clients). */

/**
 * Community-list "last activity" preview. Shared across:
 *  - `GET /communities/mine` → `CommunityListItem.lastActivity`
 *  - `community:added` socket event → `CommunityAddedPayload.lastActivity`
 *  - `community:updated` socket list-bump → carries the same shape
 *
 * Two discriminated variants:
 *  - **USER MESSAGE** (`message`/`reaction`/`edited`/`deleted`): `username` is the
 *    sender — the client renders `"<username>: <preview>"`.
 *  - **SYSTEM / lifecycle** (`system`/`created`/`join`/`removal`/`pinned`/`unpinned`):
 *    `username` is always `null` — the client renders `preview` standalone with no prefix.
 */
export type CommunityLastActivity =
  | {
      type: "message" | "reaction" | "edited" | "deleted";
      userId: string | null;
      username: string;
      preview: string;
      /** Epoch milliseconds. */
      dateTime: number;
    }
  | {
      type: "system" | "created" | "join" | "removal" | "pinned" | "unpinned";
      userId: null;
      username: null;
      preview: string;
      /** Epoch milliseconds. */
      dateTime: number;
    };

export interface CommunitySummaryDto {
  communityId: string;
  name: string;
  avatar: string | null;
  memberCount: number;
  updatedAt: number; // epoch ms
}

export interface CommunityStatsUpdatedPayload {
  communityId: string;
  memberCount: number;
  updatedAt: number; // epoch ms
}

/** Roster snapshot emitted to `community:<id>` room when a member joins. */
export interface CommunityMemberJoinedSocketPayload {
  communityId: string;
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  role: "ADMIN" | "MODERATOR" | "MEMBER";
  joinedAt: number; // epoch ms
}

/**
 * Server → client. A join request's status changed (approved/rejected), or a
 * new one was created/cancelled. Broadcast to the `community:<id>` room so
 * every connected admin/moderator's "Accept Requests" list updates in real
 * time without a manual refetch — mirrors the roster-broadcast pattern used
 * by {@link CommunityMemberJoinedSocketPayload}.
 */
export interface CommunityJoinRequestUpdatedSocketPayload {
  communityId: string;
  requestId: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  /** The requester whose request changed status. */
  userId: string;
  /** Who acted: the requester themself for PENDING/CANCELLED, the
   *  approving/rejecting admin for APPROVED/REJECTED. */
  actorId?: string;
  updatedAt: number; // epoch ms
}

export interface CommunityMemberRemovedPayload {
  communityId: string;
  userId: string; // who was removed
  reason: "kicked" | "banned" | "left";
  actorId?: string; // who performed the action; same as userId for voluntary leave
  updatedAt: number; // epoch ms
}

export interface CommunityMemberUnbannedPayload {
  communityId: string;
  userId: string; // who was unbanned
  actorId: string;
  updatedAt: number; // epoch ms
}

/**
 * Server → client. A member was muted by an admin/moderator (moderation mute —
 * the member can still read/receive but cannot post). Broadcast to the
 * `community:<id>` room (so every member's roster badge flips) AND to the muted
 * member's own `user:<id>` channel (so the composer disables on every device
 * with no refetch). Timestamps are epoch ms (wire convention). This is distinct
 * from the per-user notification mute (`CommunityMuteSetting`).
 */
export interface CommunityMemberMutedSocketPayload {
  communityId: string;
  /** The muted member's userId. */
  memberId: string;
  isMuted: true;
  /** Epoch ms when the mute expires; null = indefinite. */
  mutedUntil: number | null;
  /** The admin/moderator who muted ("" for a system auto-action). */
  actorId: string;
  updatedAt: number; // epoch ms
}

/**
 * Server → client. A member's moderation mute was lifted — either a manual
 * unmute by an admin/moderator or an automatic expiry by the sweeper. Same
 * fan-out as {@link CommunityMemberMutedSocketPayload}.
 */
export interface CommunityMemberUnmutedSocketPayload {
  communityId: string;
  /** The unmuted member's userId. */
  memberId: string;
  isMuted: false;
  mutedUntil: null;
  /** Who lifted the mute ("" for an automatic/system unmute). */
  actorId: string;
  updatedAt: number; // epoch ms
}

/**
 * Server → client. A livestream went LIVE in a community (`community:stream:started`).
 * Emitted by stream-service to the `community:<id>` room AND relayed to the
 * lightweight `community-typing:<id>` room (auto-joined by every member) so the
 * live banner / list badge appears for connected members who have NOT opened the
 * chat. Timestamps are epoch ms. `status` stays "LIVE" (the canonical stream enum
 * value). `activeLivestreamCount` is the community's LIVE-only count AFTER this
 * stream went live, clamped to the 5-stream cap; `hasActiveLivestream` is always
 * true here. Additive over the legacy `{ communityId, streamId, title, hlsUrl }`
 * payload — older listeners that read only those keys keep working.
 */
export interface CommunityStreamStartedSocketPayload {
  communityId: string;
  /** Canonical id of the stream (also mirrored as `streamId` for legacy clients). */
  livestreamId: string;
  /** @deprecated legacy alias of `livestreamId`. */
  streamId: string;
  host: {
    userId: string;
    displayName: string;
    avatarUrl: string | null;
  };
  /** Stream title, when set. */
  title: string | null;
  /** Primary playback URL (HLS), when available. */
  hlsUrl: string | null;
  status: "LIVE";
  startedAt: number; // epoch ms
  activeLivestreamCount: number;
  hasActiveLivestream: true;
}

/**
 * Server → client. A livestream ENDED in a community (`community:stream:ended`).
 * Same fan-out as {@link CommunityStreamStartedSocketPayload}. Unlike the legacy
 * behavior (which only fired when the LAST stream ended), this now fires on EVERY
 * stream end carrying the updated count — drive banner visibility off
 * `hasActiveLivestream`/`activeLivestreamCount`, NOT the mere presence of the
 * event. `hasActiveLivestream` stays true while OTHER streams remain live and
 * flips false only when the final stream ends (`activeLivestreamCount === 0`).
 */
export interface CommunityStreamEndedSocketPayload {
  communityId: string;
  livestreamId: string;
  /** @deprecated legacy alias of `livestreamId`. */
  streamId: string;
  host: {
    userId: string;
    displayName: string;
    avatarUrl: string | null;
  };
  status: "ENDED";
  endedAt: number; // epoch ms
  /** Human-readable runtime, e.g. "1h 24m". */
  duration: string;
  durationSeconds: number;
  activeLivestreamCount: number;
  hasActiveLivestream: boolean;
}

/**
 * Canonical post-update community metadata snapshot carried by
 * `community:meta:updated`. The client applies this verbatim to the detail/header
 * screen and patches the matching list row (name/avatar/description/memberCount).
 * `avatar` is an already-resolved presigned URL — render as-is, never persist it.
 */
export interface CommunityMetaDto {
  communityId: string;
  name: string;
  handle: string;
  description: string | null;
  avatar: string | null; // resolved presigned URL
  type: "PUBLIC" | "PRIVATE";
  categoryId: string | null;
  categoryName: string | null;
  memberCount: number;
  updatedAt: number; // epoch ms
}

/**
 * `community:meta:updated` — fired when a community's metadata changes
 * (name / avatar / description / category / visibility / handle). Emitted to the
 * `community:<id>` room (detail/header/chat viewers) AND to every active member's
 * `user:<id>` channel (list rows that aren't in the room). DISTINCT from the
 * list-bump `community:updated`, which carries a last-message preview and reorders
 * the list — `community:meta:updated` is a metadata patch and does NOT reorder.
 */
export interface CommunityMetaUpdatedPayload {
  communityId: string;
  /** Only the keys that genuinely changed are present and `true`. */
  changes: {
    name?: boolean;
    avatar?: boolean;
    description?: boolean;
    category?: boolean;
    visibility?: boolean;
    handle?: boolean;
  };
  community: CommunityMetaDto;
  updatedAt: number; // epoch ms — idempotency key
}

/**
 * `community:closed` — the community ADMIN/owner closed the community
 * (status → CLOSED). Broadcast to the `community:<id>` room AND to every
 * (now ex-)member's `user:<id>` channel so connected clients disable all
 * community actions immediately — no refresh, no polling. All members have
 * been auto-removed; the client should treat the community as read-only/gone
 * until a `community:reopened` arrives or the user re-joins.
 */
export interface CommunityClosedPayload {
  communityId: string;
  status: "CLOSED";
  closedAt: number; // epoch ms
  reason?: string;
}

/**
 * `community:reopened` — the community ADMIN/owner reopened a previously
 * CLOSED community (status → ACTIVE). Broadcast to the `community:<id>` room.
 * Former members are NOT auto-restored — they re-join via the normal flow.
 */
export interface CommunityReopenedPayload {
  communityId: string;
  status: "ACTIVE";
  reopenedAt: number; // epoch ms
}

/**
 * `community:added` — the recipient just became an ACTIVE member of a community
 * (admin add, join-request approval, invite-link redeem, or self-join). Delivered
 * ONLY to the new member's `user:<id>` channel — they are not yet in the
 * `community:<id>` room, so the room-scoped `community:member:joined` never
 * reaches them. Carries a full list-row snapshot so the client inserts the
 * community into the sidebar / "mine" list INSTANTLY with no GET /communities/mine
 * round-trip and no page refresh. Idempotent: the client upserts by `communityId`.
 */
export interface CommunityAddedPayload {
  /**
   * Stable per-emit identifier (UUID). OPTIONAL + additive: clients MAY dedupe
   * repeated deliveries of the SAME logical event by `eventId` (a reconnect
   * replay or a multi-gateway double-publish re-uses it). The primary ordering /
   * idempotency key remains `addedAt` (newer wins) + upsert-by-`communityId`;
   * `eventId` is belt-and-suspenders for exact-duplicate suppression.
   */
  eventId?: string;
  /** Epoch ms — when the event was emitted (server clock). Mirrors `addedAt`. */
  occurredAt?: number;
  communityId: string;
  name: string;
  handle: string;
  description: string | null;
  avatarUrl: string | null; // resolved presigned URL — render as-is, never persist
  type: "PUBLIC" | "PRIVATE";
  categoryId: string | null;
  categoryName: string | null;
  memberCount: number;
  /** The recipient's role in the community. */
  role: "ADMIN" | "MODERATOR" | "MEMBER";
  /** Owner lifecycle status: ACTIVE = open; CLOSED = owner closed (read-only). */
  status: "ACTIVE" | "CLOSED";
  /** How the recipient became a member. */
  via:
    | "created"
    | "add_members"
    | "join_request_approved"
    | "join_request_auto_accept"
    | "invite_auto_approve"
    | "invite_link_redeem"
    | "self_join";
  joinedAt: number; // epoch ms
  addedAt: number; // epoch ms — idempotency key
  /**
   * The recipient's personal last-activity preview — always their private
   * "You joined the community" system message at join time.
   *
   * Structurally identical to `CommunityListItem.lastActivity` from
   * `GET /communities/mine`. The client must upsert this directly into the
   * community-list row and MUST NOT call Mine API to back-fill it.
   */
  lastActivity: CommunityLastActivity;
}

/**
 * `community:member:updated` — a single member's roster row changed (role
 * promotion/demotion, admin transfer, or profile name/avatar sync). Room-scoped
 * to `community:<id>`; the client patches the Members page badge + chat header.
 */
export interface CommunityMemberUpdatedPayload {
  communityId: string;
  userId: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string | null;
  role?: "ADMIN" | "MODERATOR" | "MEMBER";
  updatedAt: number; // epoch ms
}
