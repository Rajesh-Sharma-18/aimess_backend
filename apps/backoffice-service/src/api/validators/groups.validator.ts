import { z } from "zod";

/**
 * Zod schemas + inferred types for the Group Management admin API.
 * Contract: docs/BACKOFFICE-API-SPEC.md (Group Management section).
 */

export const groupSortByEnum = z.enum(["createdAt", "memberCount"]);
export const groupSortOrderEnum = z.enum(["asc", "desc"]);
export const groupRoleEnum = z.enum(["OWNER", "ADMIN", "MODERATOR", "MEMBER"]);

// ---------------------------------------------------------------------------
// List query.
// ---------------------------------------------------------------------------
export const listGroupsQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  fromDate: z.iso.date().optional(),
  toDate: z.iso.date().optional(),
  sortBy: groupSortByEnum.default("createdAt"),
  sortOrder: groupSortOrderEnum.default("desc"),
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

// ---------------------------------------------------------------------------
// Members list query.
// ---------------------------------------------------------------------------
export const listGroupMembersQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  role: groupRoleEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListGroupMembersQueryInput = z.infer<
  typeof listGroupMembersQuerySchema
>;
