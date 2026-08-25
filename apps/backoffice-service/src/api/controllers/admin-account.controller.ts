import { HTTP_STATUS, t } from "@aimess/constants";
import type { RequestHandler } from "express";
import { ApiResponse } from "@aimess/utils";

import { getRequestContext } from "../../lib/request-context.js";
import { adminAccountService } from "../../services/index.js";
import { paginated } from "../lib/respond.js";
import type { ListAdminAccountsQuery } from "../../types/admin-account.types.js";
import type {
  CreateAdminAccountInput,
  ListAdminAccountsQueryInput,
  UpdateAdminAccountInput,
  UpdateAdminAccountStatusInput,
  UpdateAdminPermissionsInput,
} from "../validators/index.js";

/** GET /v1/admin-accounts — paginated, searchable, filtered list. */
export const listAdminAccounts: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const query = req.query as unknown as ListAdminAccountsQueryInput;
      const result = await adminAccountService.listAdminAccounts(
        query as ListAdminAccountsQuery,
        req.admin!
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          paginated(
            result.data,
            result.pagination,
            t("ADMIN_ACCOUNTS_FETCHED", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};

/** POST /v1/admin-accounts */
export const createAdminAccount: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const body = req.body as CreateAdminAccountInput;
      const result = await adminAccountService.createAdminAccount(
        body,
        req.admin!,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.CREATED)
        .json(new ApiResponse(result, t("ADMIN_ACCOUNT_CREATED", req.locale)));
    } catch (error) {
      next(error);
    }
  })();
};

/** GET /v1/admin-accounts/:adminId — full detail. */
export const getAdminAccountDetails: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const adminId = req.params.adminId as string;
      const result = await adminAccountService.getAdminAccount(adminId);
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(result, t("ADMIN_ACCOUNT_FETCHED", req.locale)));
    } catch (error) {
      next(error);
    }
  })();
};

/** PATCH /v1/admin-accounts/:adminId — profile fields (name/avatarUrl). */
export const updateAdminAccount: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const adminId = req.params.adminId as string;
      const body = req.body as UpdateAdminAccountInput;
      const result = await adminAccountService.updateAdminAccount(
        adminId,
        body,
        req.admin!,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(result, t("ADMIN_ACCOUNT_UPDATED", req.locale)));
    } catch (error) {
      next(error);
    }
  })();
};

/** POST /v1/admin-accounts/:adminId/activate */
export const activateAdminAccount: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const adminId = req.params.adminId as string;
      const result = await adminAccountService.activateAdminAccount(
        adminId,
        req.admin!,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(result, t("ADMIN_ACCOUNT_ACTIVATED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};

/** POST /v1/admin-accounts/:adminId/deactivate */
export const deactivateAdminAccount: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const adminId = req.params.adminId as string;
      const result = await adminAccountService.deactivateAdminAccount(
        adminId,
        req.admin!,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(result, t("ADMIN_ACCOUNT_DEACTIVATED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};

/** DELETE /v1/admin-accounts/:adminId — soft-delete a deactivated account. */
export const deleteAdminAccount: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const adminId = req.params.adminId as string;
      const result = await adminAccountService.deleteAdminAccount(
        adminId,
        req.admin!,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(result, t("ADMIN_ACCOUNT_DELETE_SUCCESS", req.locale)));
    } catch (error) {
      next(error);
    }
  })();
};

/** PATCH /v1/admin-accounts/:adminId/status — unified activate/deactivate. */
export const updateAdminAccountStatus: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const adminId = req.params.adminId as string;
      const body = req.body as UpdateAdminAccountStatusInput;
      const result = await adminAccountService.updateAdminAccountStatus(
        adminId,
        body,
        req.admin!,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(result, t("ADMIN_ACCOUNT_STATUS_UPDATED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};

/** GET /v1/admin-accounts/permissions — the full permission catalogue. */
export const listPermissions: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const result = await adminAccountService.listPermissions();
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(result, t("ADMIN_PERMISSIONS_FETCHED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};

/** GET /v1/admin-accounts/:adminId/permissions — resolved permission set for one admin. */
export const getAdminPermissions: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const adminId = req.params.adminId as string;
      const result = await adminAccountService.getAdminPermissions(adminId);
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            result,
            t("ADMIN_ACCOUNT_PERMISSIONS_FETCHED", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};

/** PATCH /v1/admin-accounts/:adminId/permissions — reassign role and/or set the permission grid. */
export const updateAdminPermissions: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const adminId = req.params.adminId as string;
      const body = req.body as UpdateAdminPermissionsInput;
      const result = await adminAccountService.updateAdminPermissions(
        adminId,
        body,
        req.admin!,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            result,
            t("ADMIN_ACCOUNT_PERMISSIONS_UPDATED", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};
