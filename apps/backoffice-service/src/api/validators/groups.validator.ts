import { z } from "zod";

/**
 * Zod schemas + inferred types for the Group Management admin API.
 * Contract: docs/BACKOFFICE-API-SPEC.md (Group Management section).
 */

export const groupSortByEnum = z.enum([
  "createdAt",
  "memberCount",
  "lastMessageAt",
]);
export const groupSortOrderEnum = z.enum(["asc", "desc"]);
export const groupRoleEnum = z.enum(["ADMIN", "MODERATOR", "MEMBER"]);
// Omitted → chat-service's ACTIVE default; "ALL" → no status filter.
export const groupStatusEnum = z.enum(["ACTIVE", "DISBANDED", "ALL"]);
export const groupMemberStatusEnum = z.enum(["ACTIVE", "ALL"]);

// ---------------------------------------------------------------------------
// List query.
// ---------------------------------------------------------------------------
export const listGroupsQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  fromDate: z.iso.date().optional(),
  toDate: z.iso.date().optional(),
  sortBy: groupSortByEnum.default("createdAt"),
  sortOrder: groupSortOrderEnum.default("desc"),
  status: groupStatusEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListGroupsQueryInput = z.infer<typeof listGroupsQuerySchema>;

// ---------------------------------------------------------------------------
// Path params.
// ---------------------------------------------------------------------------
export const groupIdParamSchema = z.object({
  groupId: z.string().trim().min(1).max(64),
});
export type GroupIdParam = z.infer<typeof groupIdParamSchema>;

export const groupMemberParamSchema = z.object({
  groupId: z.string().trim().min(1).max(64),
  userId: z.string().trim().min(1).max(64),
});
export type GroupMemberParam = z.infer<typeof groupMemberParamSchema>;

// ---------------------------------------------------------------------------
// Moderation bodies. Free text, not an enum — chat-service persists the removal
// reason verbatim as GroupMember.kickReason and has no reason field at all for
// disband (that one is recorded in the backoffice audit trail only).
// ---------------------------------------------------------------------------
export const disbandGroupSchema = z.object({
  reason: z.string().trim().min(1).max(2000).optional(),
});
export type DisbandGroupInput = z.infer<typeof disbandGroupSchema>;

export const removeGroupMemberSchema = z.object({
  reason: z.string().trim().min(1).max(2000).optional(),
});
export type RemoveGroupMemberInput = z.infer<typeof removeGroupMemberSchema>;

// ---------------------------------------------------------------------------
// Members list query.
// ---------------------------------------------------------------------------
export const listGroupMembersQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  role: groupRoleEnum.optional(),
  status: groupMemberStatusEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListGroupMembersQueryInput = z.infer<
  typeof listGroupMembersQuerySchema
>;
