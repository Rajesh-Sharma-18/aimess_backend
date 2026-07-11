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

const SORT_FIELDS = ["name", "email", "createdAt", "lastLoginAt"] as const;
const SORT_PATTERN = new RegExp(`^(${SORT_FIELDS.join("|")}):(asc|desc)$`);

// ---------------------------------------------------------------------------
// Create.
// ---------------------------------------------------------------------------
export const createAdminAccountSchema = z.object({
  email: emailSchema,
  password: adminPasswordSchema,
  name: nameSchema,
  roleKey: roleKeyEnum,
  avatarUrl: avatarUrlSchema.optional(),
});
export type CreateAdminAccountInput = z.infer<typeof createAdminAccountSchema>;

// ---------------------------------------------------------------------------
// Update (profile fields only — role/permissions go through the dedicated
// permissions endpoint below).
// ---------------------------------------------------------------------------
export const updateAdminAccountSchema = z
  .object({
    name: nameSchema.optional(),
    avatarUrl: avatarUrlSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.avatarUrl !== undefined, {
    message: "At least one of name or avatarUrl must be provided",
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
// List query.
// ---------------------------------------------------------------------------
export const listAdminAccountsQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  status: adminAccountStatusEnum.default("all"),
  roleKey: z.union([roleKeyEnum, z.literal("all")]).default("all"),
  sort: z
    .string()
    .regex(SORT_PATTERN, "Sort must be in the format field:asc or field:desc")
    .default("createdAt:desc"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
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
    message: "Passwords do not match",
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ["newPassword"],
    message: "New password must differ from the current password",
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// ---------------------------------------------------------------------------
// Path params.
// ---------------------------------------------------------------------------
export const adminAccountIdParamSchema = z.object({
  adminId: z.string().uuid("Admin id is invalid"),
});
export type AdminAccountIdParam = z.infer<typeof adminAccountIdParamSchema>;
