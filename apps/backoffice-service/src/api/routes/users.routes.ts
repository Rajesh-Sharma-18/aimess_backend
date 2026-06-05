import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import {
  banUser,
  bulkActivateUsers,
  bulkBanUsers,
  getUserDetails,
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
  listUsersQuerySchema,
  suspendUserSchema,
  unbanUserSchema,
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

// Single-user detail + actions.
usersRoutes.get(
  "/users/:userId",
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
usersRoutes.post(
  "/users/:userId/unban",
  requirePermission(PERMISSIONS.USERS_MODERATE),
  validateParams(userIdParamSchema),
  validateBody(unbanUserSchema),
  unbanUser
);
