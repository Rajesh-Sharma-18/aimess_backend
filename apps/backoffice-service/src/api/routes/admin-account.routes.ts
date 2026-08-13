import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import {
  activateAdminAccount,
  createAdminAccount,
  deactivateAdminAccount,
  getAdminAccountDetails,
  getAdminPermissions,
  listAdminAccounts,
  listPermissions,
  updateAdminAccount,
  updateAdminAccountStatus,
  updateAdminPermissions,
} from "../controllers/index.js";
import {
  adminAuth,
  requirePermission,
  validateBody,
  validateParams,
  validateQuery,
} from "../middleware/index.js";
import {
  adminAccountIdParamSchema,
  createAdminAccountSchema,
  listAdminAccountsQuerySchema,
  updateAdminAccountSchema,
  updateAdminAccountStatusSchema,
  updateAdminPermissionsSchema,
} from "../validators/index.js";

/**
 * Admin Accounts admin API — self-prefixed `/admin-accounts` so it resolves at
 * `/v1/admin-accounts/*`, matching the documented gateway path
 * `/admin/v1/admin-accounts` (the gateway strips `/admin` and forwards `/v1/*`
 * verbatim). Self-prefixed, NOT nested under a base path — same as category/
 * audit-logs. Reads require `admins.read`; every mutation requires `admins.manage`.
 */
export const adminAccountRoutes: IRouter = Router();

adminAccountRoutes.use(adminAuth);

// Permission catalogue — MUST be declared before `/:adminId` so Express does
// not capture "permissions" as an adminId path param.
adminAccountRoutes.get(
  "/admin-accounts/permissions",
  requirePermission(PERMISSIONS.ADMINS_READ),
  listPermissions
);

// Read.
adminAccountRoutes.get(
  "/admin-accounts",
  requirePermission(PERMISSIONS.ADMINS_READ),
  validateQuery(listAdminAccountsQuerySchema),
  listAdminAccounts
);
adminAccountRoutes.post(
  "/admin-accounts",
  requirePermission(PERMISSIONS.ADMINS_MANAGE),
  validateBody(createAdminAccountSchema),
  createAdminAccount
);

// Single-admin detail + actions.
adminAccountRoutes.get(
  "/admin-accounts/:adminId",
  requirePermission(PERMISSIONS.ADMINS_READ),
  validateParams(adminAccountIdParamSchema),
  getAdminAccountDetails
);
adminAccountRoutes.patch(
  "/admin-accounts/:adminId",
  requirePermission(PERMISSIONS.ADMINS_MANAGE),
  validateParams(adminAccountIdParamSchema),
  validateBody(updateAdminAccountSchema),
  updateAdminAccount
);
adminAccountRoutes.post(
  "/admin-accounts/:adminId/activate",
  requirePermission(PERMISSIONS.ADMINS_MANAGE),
  validateParams(adminAccountIdParamSchema),
  activateAdminAccount
);
adminAccountRoutes.post(
  "/admin-accounts/:adminId/deactivate",
  requirePermission(PERMISSIONS.ADMINS_MANAGE),
  validateParams(adminAccountIdParamSchema),
  deactivateAdminAccount
);
// Unified activate/deactivate toggle (Figma spec) — routes onto the same
// service methods as the two endpoints above, no duplicated business logic.
adminAccountRoutes.patch(
  "/admin-accounts/:adminId/status",
  requirePermission(PERMISSIONS.ADMINS_MANAGE),
  validateParams(adminAccountIdParamSchema),
  validateBody(updateAdminAccountStatusSchema),
  updateAdminAccountStatus
);

// Permission management for one admin.
adminAccountRoutes.get(
  "/admin-accounts/:adminId/permissions",
  requirePermission(PERMISSIONS.ADMINS_READ),
  validateParams(adminAccountIdParamSchema),
  getAdminPermissions
);
adminAccountRoutes.patch(
  "/admin-accounts/:adminId/permissions",
  requirePermission(PERMISSIONS.ADMINS_MANAGE),
  validateParams(adminAccountIdParamSchema),
  validateBody(updateAdminPermissionsSchema),
  updateAdminPermissions
);
