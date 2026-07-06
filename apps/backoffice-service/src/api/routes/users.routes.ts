import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import {
  banUser,
  bulkActivateUsers,
  bulkBanUsers,
  getBanReasons,
  getUserDetails,
  listOtherCommunityMembers,
  listUserCommunities,
  listUserReports,
  listUsers,
  suspendUser,
  unbanUser,
} from "../controllers/index.js";
import {
  adminAuth,
  requirePermission,
  validateBody,
  validateParams,
  validateQuery,
} from "../middleware/index.js";
import {
  banUserSchema,
  bulkActivateSchema,
  bulkBanSchema,
  listOtherMembersQuerySchema,
  listUserCommunitiesQuerySchema,
  listUsersQuerySchema,
  suspendUserSchema,
  unbanUserSchema,
  userCommunityMembersParamSchema,
  userIdParamSchema,
  userReportsQuerySchema,
} from "../validators/index.js";

/** Admin User Management API — self-prefixed with `/users` (→ /v1/users/*). */
export const usersRoutes: IRouter = Router();

// Every route requires a valid admin bearer.
usersRoutes.use(adminAuth);

// Read.
usersRoutes.get(
  "/users",
  requirePermission(PERMISSIONS.USERS_READ),
  validateQuery(listUsersQuerySchema),
  listUsers
);

// Bulk actions — MUST be declared before the `/:userId/*` routes so Express
// does not capture "bulk" as a userId path param.
usersRoutes.post(
  "/users/bulk/ban",
  requirePermission(PERMISSIONS.USERS_MODERATE),
  validateBody(bulkBanSchema),
  bulkBanUsers
);
usersRoutes.post(
  "/users/bulk/activate",
  requirePermission(PERMISSIONS.USERS_MODERATE),
  validateBody(bulkActivateSchema),
  bulkActivateUsers
);

// Static reference data — MUST be declared before `/:userId` so Express does
// not capture "ban-reasons" as a userId path param.
usersRoutes.get(
  "/users/ban-reasons",
  requirePermission(PERMISSIONS.USERS_READ),
  getBanReasons
);

// Single-user detail + actions.
usersRoutes.get(
  "/users/:userId",
  requirePermission(PERMISSIONS.USERS_READ),
  validateParams(userIdParamSchema),
  getUserDetails
);
// Alias of the route above (community-less user detail: profile + reports +
// moderation history, no community/members block). Reuses the same
// controller/service — added for callers that expect an explicit `/details`
// path.
usersRoutes.get(
  "/users/:userId/details",
  requirePermission(PERMISSIONS.USERS_READ),
  validateParams(userIdParamSchema),
  getUserDetails
);
usersRoutes.get(
  "/users/:userId/reports",
  requirePermission(PERMISSIONS.USERS_READ),
  validateParams(userIdParamSchema),
  validateQuery(userReportsQuerySchema),
  listUserReports
);
// User → Communities grid + the co-member grid for a specific community. The
// more-specific `/communities/:communityId/members` is declared before the
// shallower `/communities` so Express matches it first.
usersRoutes.get(
  "/users/:userId/communities/:communityId/members",
  requirePermission(PERMISSIONS.USERS_READ),
  validateParams(userCommunityMembersParamSchema),
  validateQuery(listOtherMembersQuerySchema),
  listOtherCommunityMembers
);
usersRoutes.get(
  "/users/:userId/communities",
  requirePermission(PERMISSIONS.USERS_READ),
  validateParams(userIdParamSchema),
  validateQuery(listUserCommunitiesQuerySchema),
  listUserCommunities
);
usersRoutes.post(
  "/users/:userId/ban",
  requirePermission(PERMISSIONS.USERS_MODERATE),
  validateParams(userIdParamSchema),
  validateBody(banUserSchema),
  banUser
);
usersRoutes.post(
  "/users/:userId/suspend",
  requirePermission(PERMISSIONS.USERS_MODERATE),
  validateParams(userIdParamSchema),
  validateBody(suspendUserSchema),
  suspendUser
);
// `/activate` is an alias of `/unban` (same reinstate logic) for callers that
// expect an "activate" verb — kept as one registration so both paths share
// the exact same validator + controller, no duplicated logic.
usersRoutes.post(
  ["/users/:userId/unban", "/users/:userId/activate"],
  requirePermission(PERMISSIONS.USERS_MODERATE),
  validateParams(userIdParamSchema),
  validateBody(unbanUserSchema),
  unbanUser
);
