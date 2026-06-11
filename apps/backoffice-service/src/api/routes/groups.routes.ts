import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import {
  getGroupDetails,
  listGroupMembers,
  listGroups,
} from "../controllers/index.js";
import {
  adminAuth,
  requirePermission,
  validateParams,
  validateQuery,
} from "../middleware/index.js";
import {
  groupIdParamSchema,
  listGroupMembersQuerySchema,
  listGroupsQuerySchema,
} from "../validators/index.js";

/** Group Management admin API — self-prefixed at /v1/groups. */
export const groupRoutes: IRouter = Router();

// Every route requires a valid admin bearer.
groupRoutes.use(adminAuth);

// Read.
groupRoutes.get(
  "/groups",
  requirePermission(PERMISSIONS.GROUPS_READ),
  validateQuery(listGroupsQuerySchema),
  listGroups
);

groupRoutes.get(
  "/groups/:groupId",
  requirePermission(PERMISSIONS.GROUPS_READ),
  validateParams(groupIdParamSchema),
  getGroupDetails
);

groupRoutes.get(
  "/groups/:groupId/members",
  requirePermission(PERMISSIONS.GROUPS_READ),
  validateParams(groupIdParamSchema),
  validateQuery(listGroupMembersQuerySchema),
  listGroupMembers
);
