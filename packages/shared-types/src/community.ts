/** Socket-level DTOs for community real-time events (community-service → gateway → clients). */

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
    | "add_members"
    | "join_request_approved"
    | "join_request_auto_accept"
    | "invite_auto_approve"
    | "invite_link_redeem"
    | "self_join";
  joinedAt: number; // epoch ms
  addedAt: number; // epoch ms — idempotency key
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
