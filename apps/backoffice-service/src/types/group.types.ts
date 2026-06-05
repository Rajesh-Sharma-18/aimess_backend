/**
 * View-model types for the Group Management admin API.
 * Mirror the JSON contract agreed with the frontend (field names + casing).
 * Groups live in chat-service / aimess_chat; these are composed from the
 * AdminGroup* gRPC RPCs.
 */

export type GroupRole = "OWNER" | "ADMIN" | "MODERATOR" | "MEMBER";

/** Owner of a group (role=OWNER, fallback GroupRoom.createdBy). */
export interface GroupAdmin {
  userId: string;
  username: string;
  email: string | null;
  avatarUrl: string | null;
}

/** A row in the group list / the detail payload. */
export interface GroupItem {
  id: string;
  name: string;
  avatarUrl: string | null;
  description: string;
  memberCount: number;
  createdAt: string;
  admin: GroupAdmin;
}

/** A row in the group members list. */
export interface GroupMemberItem {
  userId: string;
  username: string;
  email: string | null;
  avatarUrl: string | null;
  role: string;
  joinedAt: string;
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
