import type { Cluster, Redis } from "ioredis";

// The admin-edited app update policy. backoffice-service writes it (its
// SystemSetting row is the durable copy, re-published here on boot); every
// api-gateway node reads it to answer /app-version/check and to gate outdated
// clients. Android and iOS are independent: different version lines, modes and
// store rules.
const APP_UPDATE_POLICY_KEY = "aimess:app-update:policy";

// ADMIN_MANAGED: the admin forces versions below `forceBelowVersion` (plus any
// `blockedVersions`); every other version is left to the store.
// STORE_MANAGED: the admin forces nothing; the store decides.
export type AppUpdateMode = "ADMIN_MANAGED" | "STORE_MANAGED";

export type VersionBump = "MAJOR" | "MINOR" | "PATCH" | "OFF";

// Android: Play's per-release `inAppUpdatePriority` (0–5) decides, read on device.
export type AndroidStorePolicy = {
  forceFromPriority: number;
  softFromPriority: number;
  escalateSoftAfterDays: number | null;
};

// iOS: the App Store has no priority, so the size of the version bump decides.
export type IosStorePolicy = {
  appStoreId: string | null;
  forceOnBump: VersionBump;
  softOnBump: VersionBump;
};

export type AppUpdateCopy = { title?: string; message?: string };

// A rule for ONE app version, overriding the platform default (`mode` +
// `forceBelowVersion`) for exactly that version. ADMIN_MANAGED + forceUpdate
// forces it; anything else hands it to the store — which also exempts it from
// the default's force floor.
export type VersionRule = {
  version: string;
  mode: AppUpdateMode;
  forceUpdate: boolean;
  /** UTC epoch ms; set by backoffice when the rule is created or changed. */
  updatedAt: number;
};

type PlatformUpdatePolicyBase = {
  // The platform default: applies to every version without a `versionRules` entry.
  mode: AppUpdateMode;
  forceBelowVersion: string | null;
  // Derived from `versionRules` (the forced ones) once those exist; kept so a
  // gateway that predates `versionRules` still forces the same versions.
  blockedVersions: string[];
  // Absent on policies saved before per-version rules existed.
  versionRules?: VersionRule[];
  latestVersion: string;
  fullyRolledOut: boolean;
  minOsLevel: number | null;
  storeUrl: string | null;
  enforceOnServer: boolean;
  copy: Record<string, AppUpdateCopy>;
};

export type AndroidUpdatePolicy = PlatformUpdatePolicyBase & {
  store: AndroidStorePolicy;
};

export type IosUpdatePolicy = PlatformUpdatePolicyBase & {
  store: IosStorePolicy;
};

export type AppUpdatePolicy = {
  android: AndroidUpdatePolicy;
  ios: IosUpdatePolicy;
  policyVersion: number;
  updatedAt: string;
};

export async function publishAppUpdatePolicy(
  redis: Redis | Cluster,
  policy: AppUpdatePolicy
): Promise<void> {
  await redis.set(APP_UPDATE_POLICY_KEY, JSON.stringify(policy));
}

// `null` when nothing has been published yet; callers fall back to their own
// static defaults. A malformed value is treated the same way rather than thrown,
// so a bad write can never take /app-version/check down.
export async function readAppUpdatePolicy(
  redis: Redis | Cluster
): Promise<AppUpdatePolicy | null> {
  const raw = await redis.get(APP_UPDATE_POLICY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AppUpdatePolicy;
    return parsed.android && parsed.ios ? parsed : null;
  } catch {
    return null;
  }
}
