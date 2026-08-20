/**
 * View-model types for the Group Management admin API.
 * Mirror the JSON contract agreed with the frontend (field names + casing).
 * Groups live in chat-service / aimess_chat; these are composed from the
 * AdminGroup* gRPC RPCs.
 */

import type { MediaObject } from "@aimess/shared-types";

export type GroupRole = "ADMIN" | "MODERATOR" | "MEMBER";

/** Owner of a group (role=ADMIN, fallback GroupRoom.createdBy). */
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
  // Group lifecycle: ACTIVE | DISBANDED | CLOSED (chat-service GroupRoom.status).
  status: string;
  // Owner's ACCOUNT status from auth: ACTIVE | SUSPENDED | BANNED.
  ownerAccountStatus: string;
  // Epoch ms; null when the group was never disbanded / has no messages yet.
  disbandedAt: number | null;
  lastMessageAt: number | null;
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
  // Membership state: ACTIVE | KICKED | BANNED | LEFT (chat-service GroupMember.status).
  status: string;
  // Owner-of-account state from the backoffice UserIndex mirror: ACTIVE | BANNED
  // | SUSPENDED. Lets the panel hide the ban action for a SYSTEM-banned user.
  accountStatus: string;
  // Epoch ms; null unless the member was actually kicked / banned.
  kickedAt: number | null;
  bannedAt: number | null;
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
  sortBy: "createdAt" | "memberCount" | "lastMessageAt";
  sortOrder: "asc" | "desc";
  status?: "ACTIVE" | "DISBANDED" | "ALL";
  page: number;
  limit: number;
}

/** Normalized list-group-members query (post-validation). */
export interface ListGroupMembersQuery {
  q?: string;
  role?: GroupRole;
  status?: "ACTIVE" | "BANNED" | "ALL";
  page: number;
  limit: number;
}

/** Group Conversation viewer — before_seq cursor page request. */
export type GroupConversationMessagesQuery = {
  cursor?: string;
  limit: number;
};

/** One message row in the Group Conversation viewer (mirrors the community one). */
export type GroupConversationMessageItem = {
  messageId: string;
  senderId: string;
  senderName: string;
  // Presigned URL, or null when the sender had no avatar.
  senderAvatar: string | null;
  message: string;
  contentType: string;
  attachments: unknown[];
  reactions: unknown[];
  quoteData: unknown | null;
  sentAt: number;
  systemMessageType: string | null;
  isDeleted: boolean;
};

/** Group Conversation viewer — paginated message read result. */
export type GroupConversationMessagesResult = {
  messages: GroupConversationMessageItem[];
  nextCursor: string | null;
  hasMore: boolean;
};
