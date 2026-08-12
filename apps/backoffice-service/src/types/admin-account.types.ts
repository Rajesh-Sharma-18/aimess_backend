/**
 * View-model types for the Admin Accounts admin API (Admin CRUD + permission
 * management). Field names + casing are the stable API contract.
 */

import type { MediaObject } from "@aimess/shared-types";

export type AdminAccountStatus = "ACTIVE" | "DISABLED" | "INVITED" | "DELETED";

export type AdminAccountRole = {
  key: string;
  name: string;
};

/** A single row returned by GET /admin-accounts. Same shape for detail/create/update. */
export type AdminAccountListItem = {
  id: string;
  email: string;
  name: string;
  // Standard avatar object (see @aimess/shared-types MediaObject); null when
  // no avatar is set. Replaces the legacy bare avatarUrl string.
  avatar: MediaObject | null;
  role: AdminAccountRole;
  status: AdminAccountStatus;
  lastLoginAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type AdminAccountDetail = AdminAccountListItem;

/** Normalized create input (post-validation). */
export type CreateAdminAccountInput = {
  email: string;
  password: string;
  name: string;
  roleKey: string;
  avatarUrl?: string;
};

/** Normalized update input (post-validation) — at least one field present. */
export type UpdateAdminAccountInput = {
  name?: string;
  email?: string;
  avatarUrl?: string;
};

/** Normalized list query (post-validation/coercion). */
export type ListAdminAccountsQuery = {
  search?: string;
  status?: AdminAccountStatus | "all";
  roleKey?: string;
  sort: string;
  fromDate?: number;
  toDate?: number;
  page: number;
  limit: number;
};

/** Normalized "update status" input — the unified activate/deactivate endpoint. */
export type UpdateAdminAccountStatusInput = {
  status: "ACTIVE" | "INACTIVE";
};

/** A single entry in the permission catalogue (GET /admin-accounts/permissions). */
export type PermissionCatalogueItem = {
  key: string;
  group: string;
};

/** The resolved permission set for one admin (GET /admin-accounts/:adminId/permissions). */
export type AdminPermissionsView = {
  adminId: string;
  role: AdminAccountRole;
  permissions: string[];
  // Role baseline + the per-admin deltas, so the toggle grid can tell "on
  // because the role grants it" from "on because someone granted it here".
  rolePermissions?: string[];
  overrides?: { key: string; allow: boolean }[];
};

/** Normalized "update admin permissions" input — role reassignment and/or the desired permission set. */
export type UpdateAdminPermissionsInput = {
  roleKey?: string;
  permissions?: string[];
};

export type PaginationMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
};

export type Paginated<T> = {
  data: T[];
  pagination: PaginationMeta;
};
