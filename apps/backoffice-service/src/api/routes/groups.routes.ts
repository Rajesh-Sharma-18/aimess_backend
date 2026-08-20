import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import {
  disbandGroup,
  getGroupConversationMessages,
  getGroupDetails,
  listGroupMembers,
  listGroups,
  removeGroupMember,
} from "../controllers/index.js";
import {
  adminAuth,
  requirePermission,
  validateBody,
  validateParams,
  validateQuery,
} from "../middleware/index.js";
import {
  disbandGroupSchema,
  groupIdParamSchema,
  groupMemberParamSchema,
  groupMessagesQuerySchema,
  listGroupMembersQuerySchema,
  listGroupsQuerySchema,
  removeGroupMemberSchema,
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
  requirePermission(PERMISSIONS.GROUPS_VIEW),
  validateParams(groupIdParamSchema),
  getGroupDetails
);

groupRoutes.get(
  "/groups/:groupId/members",
  requirePermission(PERMISSIONS.GROUPS_VIEW),
  validateParams(groupIdParamSchema),
  validateQuery(listGroupMembersQuerySchema),
  listGroupMembers
);

// Read-only Group Conversation viewer. Carries the same message bodies a
// member would see; now gated on GROUPS_VIEW (implied by GROUPS_MODERATE)
// so a view-only admin can open the transcript without holding the
// destructive-action key.
groupRoutes.get(
  "/groups/:groupId/messages",
  requirePermission(PERMISSIONS.GROUPS_VIEW),
  validateParams(groupIdParamSchema),
  validateQuery(groupMessagesQuerySchema),
  getGroupConversationMessages
);

// Moderate. Destructive lifecycle actions are POST /<resource>/:id/<verb>.
groupRoutes.post(
  "/groups/:groupId/disband",
  requirePermission(PERMISSIONS.GROUPS_MODERATE),
  validateParams(groupIdParamSchema),
  validateBody(disbandGroupSchema),
  disbandGroup
);

groupRoutes.post(
  "/groups/:groupId/members/:userId/remove",
  requirePermission(PERMISSIONS.GROUPS_MODERATE),
  validateParams(groupMemberParamSchema),
  validateBody(removeGroupMemberSchema),
  removeGroupMember
);
