/**
 * View-model types for the Group Management admin API.
 * Mirror the JSON contract agreed with the frontend (field names + casing).
 * Groups live in chat-service / aimess_chat; these are composed from the
 * AdminGroup* gRPC RPCs.
 */

import type { MediaObject } from "@aimess/shared-types";

export type GroupRole = "OWNER" | "ADMIN" | "MODERATOR" | "MEMBER";

/** Owner of a group (role=OWNER, fallback GroupRoom.createdBy). */
export interface GroupAdmin {
  userId: string;
  username: string;
  email: string | null;
  // Standard avatar object (see @aimess/shared-types MediaObject); null when
  // no avatar is set. Replaces the legacy bare avatarUrl string.
  avatar: MediaObject | null;
}

/** A row in the group list / the detail payload. */
export interface GroupItem {
  id: string;
  name: string;
  // Standard avatar object (see @aimess/shared-types MediaObject); null when
  // no avatar is set. Replaces the legacy bare avatarUrl string.
  avatar: MediaObject | null;
  description: string;
  memberCount: number;
  createdAt: number;
  admin: GroupAdmin;
}

/** A row in the group members list. */
export interface GroupMemberItem {
  userId: string;
  username: string;
  email: string | null;
  // Standard avatar object (see @aimess/shared-types MediaObject); null when
  // no avatar is set. Replaces the legacy bare avatarUrl string.
  avatar: MediaObject | null;
  role: string;
  joinedAt: number;
}

/** Offset-pagination meta for group list responses. */
export interface GroupPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

/** Normalized list-groups query (post-validation). */
export interface ListGroupsQuery {
  q?: string;
  fromDate?: string;
  toDate?: string;
  sortBy: "createdAt" | "memberCount";
  sortOrder: "asc" | "desc";
  page: number;
  limit: number;
}

/** Normalized list-group-members query (post-validation). */
export interface ListGroupMembersQuery {
  q?: string;
  role?: GroupRole;
  page: number;
  limit: number;
}
