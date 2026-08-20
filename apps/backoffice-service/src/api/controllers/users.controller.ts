import { NotFoundError } from "@aimess/errors";
import type { RequestHandler } from "express";
import { ApiResponse } from "@aimess/utils";

import { getRequestContext } from "../../lib/request-context.js";
import { userManagementService } from "../../services/index.js";
import { paginated } from "../lib/respond.js";
import type { ListUsersQuery } from "../../types/user-management.types.js";
import type { ListUserCommunitiesQuery } from "../../types/community.types.js";
import { moderationReasonEnum, unbanUserSchema } from "../validators/index.js";
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
import { HTTP_STATUS, t } from "@aimess/constants";

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
      res
        .status(HTTP_STATUS.OK)
        .json(
          paginated(
            result.data,
            result.pagination,
            t("ADMIN_USERS_FETCHED", req.locale)
          )
        );
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
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          moderationReasonEnum.options,
          t("ADMIN_BAN_REASONS_FETCHED", req.locale)
        )
      );
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
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(user, t("ADMIN_USER_FETCHED", req.locale)));
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
      res
        .status(HTTP_STATUS.OK)
        .json(
          paginated(
            result.data,
            result.pagination,
            t("ADMIN_USER_REPORTS_FETCHED", req.locale)
          )
        );
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
      res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
          {
            items: result.data,
            pagination: result.pagination,
          },
          t("ADMIN_USER_COMMUNITIES_FETCHED", req.locale)
        )
      );
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
      res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
          {
            community: result.community,
            items: result.items,
            pagination: result.pagination,
          },
          t("ADMIN_COMMUNITY_CO_MEMBERS_FETCHED", req.locale)
        )
      );
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
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(result, t("ADMIN_USER_BANNED", req.locale)));
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
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(result, t("ADMIN_USER_SUSPENDED", req.locale)));
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
      // Still no `validateBody` on this route — a request with no body at all
      // (no Content-Type) leaves `req.body` undefined, not `{}`, and Express
      // would 400 before the schema ran. Parse it here instead so the optional
      // banType/communityId are validated without breaking body-less callers.
      const body = unbanUserSchema.parse(req.body ?? {}) as UnbanUserInput;
      const result = await userManagementService.unbanUser(
        userId,
        body,
        req.admin!,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(result, t("ADMIN_USER_UNBANNED", req.locale)));
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
      res
        .status(207)
        .json(
          new ApiResponse(result, t("ADMIN_USERS_BULK_BANNED", req.locale))
        );
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
      res
        .status(207)
        .json(
          new ApiResponse(result, t("ADMIN_USERS_BULK_ACTIVATED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};
