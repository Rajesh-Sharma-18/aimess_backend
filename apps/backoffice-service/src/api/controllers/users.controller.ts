import { NotFoundError } from "@aimess/errors";
import type { RequestHandler } from "express";

import { getRequestContext } from "../../lib/request-context.js";
import { userManagementService } from "../../services/index.js";
import type { ListUsersQuery } from "../../types/user-management.types.js";
import type {
  BanUserInput,
  BulkActivateInput,
  BulkBanInput,
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
        query as ListUsersQuery
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

/** POST /v1/users/:userId/ban. */
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

/** POST /v1/users/:userId/suspend. */
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

/** POST /v1/users/:userId/unban. */
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

/** POST /v1/users/bulk/ban — 207 Multi-Status. */
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

/** POST /v1/users/bulk/activate — 207 Multi-Status. */
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
