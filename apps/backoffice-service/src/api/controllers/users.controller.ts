import { NotFoundError } from "@aimess/errors";
import type { RequestHandler } from "express";

import { getRequestContext } from "../../lib/request-context.js";
import { userManagementService } from "../../services/index.js";
import type { ListUsersQuery } from "../../types/user-management.types.js";
import type { ListUserCommunitiesQuery } from "../../types/community.types.js";
import { moderationReasonEnum } from "../validators/index.js";
import type {
  BanUserInput,
  BulkActivateInput,
  BulkBanInput,
  ListOtherMembersQueryInput,
  ListUserCommunitiesQueryInput,
  ListUsersQueryInput,
  SuspendUserInput,
  UnbanUserInput,
  UserReportsQueryInput,
} from "../validators/index.js";
import { HTTP_STATUS } from "@aimess/constants";

/** GET /v1/users — paginated, filtered list. */
export const listUsers: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const query = req.query as unknown as ListUsersQueryInput;
      const result = await userManagementService.listUsers(
        query as ListUsersQuery,
        req.admin!,
        getRequestContext(req)
      );
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * GET /v1/users/ban-reasons — the predefined reason codes for the ban/suspend
 * modal's dropdown. Read-only reference data (no DB/gRPC call): the codes are
 * the source-of-truth `moderationReasonEnum` the ban/suspend validators
 * already enforce as one accepted shape of `reason`. The admin can still type
 * any custom free-text reason instead — this list is a convenience preset,
 * not an exhaustive constraint.
 */
export const getBanReasons: RequestHandler = (req, res, next) => {
  try {
    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: moderationReasonEnum.options,
    });
  } catch (error) {
    next(error);
  }
};

/** GET /v1/users/:userId — full detail. */
export const getUserDetails: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by userIdParamSchema on the route.
      const userId = req.params.userId as string;
      const user = await userManagementService.getUser(userId);
      if (!user) throw new NotFoundError("USER_NOT_FOUND");
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: user,
      });
    } catch (error) {
      next(error);
    }
  })();
};

/** GET /v1/users/:userId/reports — paginated "Reported Details". */
export const listUserReports: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const userId = req.params.userId as string;
      const { page, limit } = req.query as unknown as UserReportsQueryInput;
      const result = await userManagementService.listUserReports(
        userId,
        page,
        limit
      );
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * GET /v1/users/:userId/communities — the "Communities" grid (communities the
 * user is an ACTIVE member of). Responds `{ success, data: { items, pagination } }`.
 */
export const listUserCommunities: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by userIdParamSchema on the route.
      const userId = req.params.userId as string;
      const query = req.query as unknown as ListUserCommunitiesQueryInput;
      const result = await userManagementService.listUserCommunities(
        userId,
        query as unknown as ListUserCommunitiesQuery,
        req.admin!,
        getRequestContext(req)
      );
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: {
          items: result.data,
          pagination: result.pagination,
        },
      });
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * GET /v1/users/:userId/communities/:communityId/members — the co-member grid:
 * the OTHER members of a community the user belongs to. The viewed user is
 * excluded at the DB level (`excludeUserId = :userId`) and never appears.
 * Responds `{ success, data: { community, items, pagination } }`.
 */
export const listOtherCommunityMembers: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      // Narrowed by userCommunityMembersParamSchema on the route.
      const userId = req.params.userId as string;
      const communityId = req.params.communityId as string;
      const query = req.query as unknown as ListOtherMembersQueryInput;
      const result = await userManagementService.listOtherCommunityMembers(
        userId,
        communityId,
        query,
        req.admin!,
        getRequestContext(req)
      );
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: {
          community: result.community,
          items: result.items,
          pagination: result.pagination,
        },
      });
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * POST /v1/users/:userId/ban.
 * TODO (Phase 2): Add step-up TOTP auth validation via X-Totp-Code header.
 */
export const banUser: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const userId = req.params.userId as string;
      const body = req.body as BanUserInput;
      const result = await userManagementService.banUser(
        userId,
        body,
        req.admin!,
        getRequestContext(req)
      );
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * POST /v1/users/:userId/suspend.
 * TODO (Phase 2): Add step-up TOTP auth validation via X-Totp-Code header.
 */
export const suspendUser: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const userId = req.params.userId as string;
      const body = req.body as SuspendUserInput;
      const result = await userManagementService.suspendUser(
        userId,
        body,
        req.admin!,
        getRequestContext(req)
      );
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * POST /v1/users/:userId/unban.
 * TODO (Phase 2): Consider adding step-up TOTP auth validation via X-Totp-Code header for consistency.
 */
export const unbanUser: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const userId = req.params.userId as string;
      const body = req.body as UnbanUserInput;
      const result = await userManagementService.unbanUser(
        userId,
        body,
        req.admin!,
        getRequestContext(req)
      );
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * POST /v1/users/bulk/ban — 207 Multi-Status.
 * TODO (Phase 2): Add step-up TOTP auth validation via X-Totp-Code header.
 */
export const bulkBanUsers: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { userIds, ...input } = req.body as BulkBanInput;
      const result = await userManagementService.bulkBan(
        userIds,
        { userIds, ...input },
        req.admin!,
        getRequestContext(req)
      );
      res.status(207).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * POST /v1/users/bulk/activate — 207 Multi-Status.
 * TODO (Phase 2): Consider adding step-up TOTP auth validation via X-Totp-Code header for consistency.
 */
export const bulkActivateUsers: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { userIds, ...input } = req.body as BulkActivateInput;
      const result = await userManagementService.bulkActivate(
        userIds,
        { userIds, ...input },
        req.admin!,
        getRequestContext(req)
      );
      res.status(207).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  })();
};
