import { NotFoundError } from "@aimess/errors";
import { HTTP_STATUS } from "@aimess/constants";
import type { RequestHandler } from "express";

import { getRequestContext } from "../../lib/request-context.js";
import { groupService } from "../../services/index.js";
import type {
  ListGroupMembersQuery,
  ListGroupsQuery,
} from "../../types/group.types.js";
import type {
  DisbandGroupInput,
  ListGroupMembersQueryInput,
  ListGroupsQueryInput,
  RemoveGroupMemberInput,
} from "../validators/index.js";

/** GET /v1/groups — paginated, filtered list. */
export const listGroups: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const query = req.query as unknown as ListGroupsQueryInput;
      const result = await groupService.listGroups(
        query as ListGroupsQuery,
        req.admin!,
        getRequestContext(req)
      );
      res.status(HTTP_STATUS.OK).json({
        success: true,
        message: "Groups fetched successfully",
        data: {
          items: result.items,
          pagination: result.pagination,
        },
      });
    } catch (error) {
      next(error);
    }
  })();
};

/** GET /v1/groups/:groupId — full detail. */
export const getGroupDetails: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by groupIdParamSchema on the route.
      const groupId = req.params.groupId as string;
      const group = await groupService.getGroup(
        groupId,
        req.admin!,
        getRequestContext(req)
      );
      if (!group) throw new NotFoundError("GROUP_NOT_FOUND");
      res.status(HTTP_STATUS.OK).json({
        success: true,
        message: "Group fetched successfully",
        data: group,
      });
    } catch (error) {
      next(error);
    }
  })();
};

/** GET /v1/groups/:groupId/members — paginated, filtered member list. */
export const listGroupMembers: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by groupIdParamSchema on the route.
      const groupId = req.params.groupId as string;
      const query = req.query as unknown as ListGroupMembersQueryInput;
      const result = await groupService.listGroupMembers(
        groupId,
        query as ListGroupMembersQuery,
        req.admin!,
        getRequestContext(req)
      );
      if (!result.found) throw new NotFoundError("GROUP_NOT_FOUND");
      res.status(HTTP_STATUS.OK).json({
        success: true,
        message: "Group members fetched successfully",
        data: {
          items: result.items,
          pagination: result.pagination,
        },
      });
    } catch (error) {
      next(error);
    }
  })();
};

// POST /v1/groups/:groupId/disband.
export const disbandGroup: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by groupIdParamSchema on the route.
      const groupId = req.params.groupId as string;
      const body = req.body as DisbandGroupInput;
      const result = await groupService.disbandGroup(
        groupId,
        body.reason,
        req.admin!,
        getRequestContext(req)
      );
      res.status(HTTP_STATUS.OK).json({
        success: true,
        message: "Group disbanded successfully",
        data: result,
      });
    } catch (error) {
      next(error);
    }
  })();
};

// POST /v1/groups/:groupId/members/:userId/remove.
export const removeGroupMember: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by groupMemberParamSchema on the route.
      const groupId = req.params.groupId as string;
      const userId = req.params.userId as string;
      const body = req.body as RemoveGroupMemberInput;
      const result = await groupService.removeGroupMember(
        groupId,
        userId,
        body.reason,
        req.admin!,
        getRequestContext(req)
      );
      res.status(HTTP_STATUS.OK).json({
        success: true,
        message: "Group member removed successfully",
        data: result,
      });
    } catch (error) {
      next(error);
    }
  })();
};
