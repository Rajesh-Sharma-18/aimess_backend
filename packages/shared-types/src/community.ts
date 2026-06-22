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
