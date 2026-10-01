import { z } from "zod";

/**
 * `confirm` must be sent as literal `true` — this is a blast-radius trip-wire
 * for a platform-wide destructive action, not the access control (that's
 * `requirePermission(PERMISSIONS.SETTINGS_MANAGE)` on the route). Omitting it,
 * or sending `false`, fails validation before the request ever reaches the
 * controller.
 */
export const disconnectAllFriendshipsSchema = z.object({
  confirm: z.literal(true),
});

export type DisconnectAllFriendshipsInput = z.infer<
  typeof disconnectAllFriendshipsSchema
>;

/**
 * Body for PATCH /v1/system/calling. No `confirm` trip-wire here: unlike the
 * friendship sweep this is fully reversible and destroys nothing — disabling
 * blocks new calls, and flipping it back restores service immediately.
 */
export const setCallingEnabledSchema = z.object({
  enabled: z.boolean(),
});

export type SetCallingEnabledInput = z.infer<typeof setCallingEnabledSchema>;

const APP_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;

const appVersion = z
  .string()
  .trim()
  .regex(APP_VERSION, "Version must be major.minor.patch (e.g. 2.1.0)");

function compareAppVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

const BUMP_RANK = { OFF: 0, PATCH: 1, MINOR: 2, MAJOR: 3 } as const;
const versionBump = z.enum(["MAJOR", "MINOR", "PATCH", "OFF"]);

const platformPolicyFields = {
  mode: z.enum(["ADMIN_MANAGED", "STORE_MANAGED"]),
  forceBelowVersion: appVersion.nullable(),
  blockedVersions: z.array(appVersion).max(50),
  latestVersion: appVersion,
  fullyRolledOut: z.boolean(),
  minOsLevel: z.number().int().min(0).max(1000).nullable(),
  storeUrl: z
    .string()
    .trim()
    .max(500)
    .regex(/^(https|market|itms-apps):\/\//i, "Store URL must be https, market or itms-apps")
    .nullable(),
  enforceOnServer: z.boolean(),
  copy: z.record(
    z.string().regex(/^[a-z]{2}$/, "Locale must be a 2-letter code"),
    z.object({
      title: z.string().trim().max(80).optional(),
      message: z.string().trim().max(500).optional(),
    })
  ),
};

/**
 * A force rule promises every forced user an installable update. Forcing below a
 * version that is still rolling out would block users the store hasn't offered it
 * to yet, so the force version must be below `latestVersion`, or equal to it only
 * once that release is fully rolled out.
 */
function forceVersionIsInstallable(policy: {
  forceBelowVersion: string | null;
  latestVersion: string;
  fullyRolledOut: boolean;
}): boolean {
  if (!policy.forceBelowVersion) return true;
  const cmp = compareAppVersions(policy.forceBelowVersion, policy.latestVersion);
  return cmp < 0 || (cmp === 0 && policy.fullyRolledOut);
}

const FORCE_NOT_INSTALLABLE = {
  message:
    "Force version must be below the latest version, or equal to it once that release is fully rolled out",
  path: ["forceBelowVersion"],
};

const androidUpdatePolicySchema = z
  .object({
    ...platformPolicyFields,
    store: z
      .object({
        forceFromPriority: z.number().int().min(0).max(5),
        softFromPriority: z.number().int().min(0).max(5),
        escalateSoftAfterDays: z.number().int().min(1).max(365).nullable(),
      })
      .refine((s) => s.softFromPriority <= s.forceFromPriority, {
        message: "Soft priority threshold can't be above the force threshold",
        path: ["softFromPriority"],
      }),
  })
  .refine(forceVersionIsInstallable, FORCE_NOT_INSTALLABLE);

const iosUpdatePolicySchema = z
  .object({
    ...platformPolicyFields,
    store: z
      .object({
        appStoreId: z.string().regex(/^\d{1,15}$/, "App Store id is numeric").nullable(),
        forceOnBump: versionBump,
        softOnBump: versionBump,
      })
      .refine(
        (s) =>
          s.forceOnBump === "OFF" ||
          s.softOnBump === "OFF" ||
          BUMP_RANK[s.forceOnBump] > BUMP_RANK[s.softOnBump],
        {
          message: "The force bump must be larger than the soft bump",
          path: ["forceOnBump"],
        }
      ),
  })
  .refine(forceVersionIsInstallable, FORCE_NOT_INSTALLABLE);

/** Body for PUT /v1/system/app-update-policy. Android and iOS are independent. */
export const appUpdatePolicySchema = z.object({
  android: androidUpdatePolicySchema,
  ios: iosUpdatePolicySchema,
});

export type AppUpdatePolicyInput = z.infer<typeof appUpdatePolicySchema>;
