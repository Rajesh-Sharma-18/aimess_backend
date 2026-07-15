import { z } from "zod";

import { ROLE_KEYS } from "../../constants/index.js";

/**
 * Zod schemas + inferred types for the Admin Accounts admin API (Admin CRUD +
 * permission management). Mirrors the pattern in category.validator.ts /
 * audit-log.validator.ts (whitelisted sort, offset pagination). Password
 * policy mirrors `adminPasswordSchema` in password-reset.validator.ts.
 */

const ROLE_KEY_VALUES = Object.values(ROLE_KEYS) as [string, ...string[]];
export const roleKeyEnum = z.enum(ROLE_KEY_VALUES);

export const adminAccountStatusEnum = z.enum([
  "ACTIVE",
  "DISABLED",
  "INVITED",
  "all",
]);

/** Wire-facing status used by the list/status-toggle endpoints — "INACTIVE" is the
 * external alias for the internal "DISABLED" status (mapped in the transforms below). */
export const adminAccountWireStatusEnum = z.enum(["ACTIVE", "INACTIVE"]);

const emailSchema = z.string().trim().toLowerCase().email("Email is invalid");

const nameSchema = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters")
  .max(100, "Name must be at most 100 characters");

/** Admin password policy: min 6 chars with upper + lower + digit + special. */
const adminPasswordSchema = z
  .string()
  .min(6, "Password must be at least 6 characters")
  .refine((v) => /[A-Z]/.test(v), {
    message: "Password must contain an uppercase letter",
  })
  .refine((v) => /[a-z]/.test(v), {
    message: "Password must contain a lowercase letter",
  })
  .refine((v) => /\d/.test(v), {
    message: "Password must contain a digit",
  })
  .refine((v) => /[^A-Za-z0-9]/.test(v), {
    message: "Password must contain a special character",
  });

const avatarUrlSchema = z.string().trim().url("Avatar URL is invalid").max(500);

/**
 * MinIO object key produced by the shared `/media/upload-url` flow (USER_AVATAR
 * category). Same shape as community/livestream avatar accept-fields. The stored
 * column keeps its historical name `avatarUrl`; only the wire field is renamed.
 */
const avatarObjectKeySchema = z.string().trim().min(1).max(512);

const SORT_FIELDS = [
  "name",
  "email",
  "createdAt",
  "lastLoginAt",
  "status",
] as const;
const SORT_PATTERN = new RegExp(`^(${SORT_FIELDS.join("|")}):(asc|desc)$`);

/** `sortBy` values accepted by the Figma-spec list endpoint, aliased onto the real column. */
const SORT_BY_FIELD_ALIAS: Record<string, (typeof SORT_FIELDS)[number]> = {
  username: "name",
  email: "email",
  createdAt: "createdAt",
  status: "status",
};

// ---------------------------------------------------------------------------
// Create.
// ---------------------------------------------------------------------------
export const createAdminAccountSchema = z
  .object({
    // `username` is the wire field per the Figma spec; `name` is kept accepted
    // for backward compatibility (same as updateMeSchema's username/name split).
    username: nameSchema.optional(),
    name: nameSchema.optional(),
    email: emailSchema,
    password: adminPasswordSchema,
    // Defaults to the standard ADMIN role when omitted ("reuse existing
    // Platform Admin role" — closest existing RoleKey).
    roleKey: roleKeyEnum.default(ROLE_KEYS.ADMIN),
    avatarUrl: avatarUrlSchema.optional(),
  })
  .refine((v) => v.username !== undefined || v.name !== undefined, {
    message: "username is required",
    path: ["username"],
  })
  .transform((v) => {
    const { username, ...rest } = v;
    return { ...rest, name: (username ?? rest.name) as string };
  });
export type CreateAdminAccountInput = z.infer<typeof createAdminAccountSchema>;

// ---------------------------------------------------------------------------
// Update (profile fields only — role/permissions go through the dedicated
// permissions endpoint below).
// ---------------------------------------------------------------------------
export const updateAdminAccountSchema = z
  .object({
    username: nameSchema.optional(),
    name: nameSchema.optional(),
    email: emailSchema.optional(),
    avatarUrl: avatarUrlSchema.optional(),
  })
  .refine(
    (v) =>
      v.username !== undefined ||
      v.name !== undefined ||
      v.email !== undefined ||
      v.avatarUrl !== undefined,
    { message: "At least one of username, email or avatarUrl must be provided" }
  )
  .transform((v) => {
    const { username, ...rest } = v;
    return { ...rest, name: username ?? rest.name };
  });
export type UpdateAdminAccountInput = z.infer<typeof updateAdminAccountSchema>;

// ---------------------------------------------------------------------------
// Update admin permissions (role reassignment — permissions are role-derived).
// ---------------------------------------------------------------------------
export const updateAdminPermissionsSchema = z.object({
  roleKey: roleKeyEnum,
});
export type UpdateAdminPermissionsInput = z.infer<
  typeof updateAdminPermissionsSchema
>;

// ---------------------------------------------------------------------------
// Activate / deactivate via unified status endpoint.
// ---------------------------------------------------------------------------
export const updateAdminAccountStatusSchema = z.object({
  status: adminAccountWireStatusEnum,
});
export type UpdateAdminAccountStatusInput = z.infer<
  typeof updateAdminAccountStatusSchema
>;

// ---------------------------------------------------------------------------
// List query.
// ---------------------------------------------------------------------------
export const listAdminAccountsQuerySchema = z
  .object({
    search: z.string().trim().min(1).optional(),
    status: z
      .union([adminAccountStatusEnum, z.literal("INACTIVE")])
      .default("all"),
    roleKey: z.union([roleKeyEnum, z.literal("all")]).default("all"),
    sort: z
      .string()
      .regex(SORT_PATTERN, "Sort must be in the format field:asc or field:desc")
      .optional(),
    sortBy: z.enum(["username", "email", "createdAt", "status"]).optional(),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
    fromDate: z.coerce.number().int().nonnegative().optional(),
    toDate: z.coerce.number().int().nonnegative().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((v) => !v.fromDate || !v.toDate || v.fromDate <= v.toDate, {
    message: "fromDate must be before or equal to toDate",
    path: ["fromDate"],
  })
  .transform((v) => ({
    ...v,
    status: v.status === "INACTIVE" ? ("DISABLED" as const) : v.status,
    sort:
      v.sort ??
      `${SORT_BY_FIELD_ALIAS[v.sortBy ?? "createdAt"]}:${v.sortOrder}`,
  }));
export type ListAdminAccountsQueryInput = z.infer<
  typeof listAdminAccountsQuerySchema
>;

// ---------------------------------------------------------------------------
// Self-service "My Account" (PATCH /me + PATCH /change-password).
// Reuses email/name/password schemas — no duplicate validation.
// ---------------------------------------------------------------------------
export const updateMeSchema = z
  .object({
    // FE calls this "username"; DB column is `name` — same field, two names.
    username: nameSchema.optional(),
    email: emailSchema.optional(),
    // Nullable so the admin can clear their avatar. Object key produced by the
    // shared USER_AVATAR upload flow; response returns the resolved MediaObject.
    avatarObjectKey: avatarObjectKeySchema.nullable().optional(),
  })
  .refine(
    (v) =>
      v.username !== undefined ||
      v.email !== undefined ||
      v.avatarObjectKey !== undefined,
    { message: "At least one field is required to update" }
  );
export type UpdateMeInput = z.infer<typeof updateMeSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: adminPasswordSchema,
    confirmPassword: z.string().min(1, "Confirm password is required"),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "New password and confirm password do not match.",
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ["newPassword"],
    message: "New password must be different from the current password.",
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// ---------------------------------------------------------------------------
// Path params.
// ---------------------------------------------------------------------------
export const adminAccountIdParamSchema = z.object({
  adminId: z.string().uuid("Admin id is invalid"),
});
export type AdminAccountIdParam = z.infer<typeof adminAccountIdParamSchema>;
