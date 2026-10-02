import type {
  AndroidStorePolicy,
  AppUpdateMode,
  IosStorePolicy,
} from "@aimess/redis";

export const APP_PLATFORMS = ["android", "ios"] as const;

export type AppPlatform = (typeof APP_PLATFORMS)[number];

/** Legacy static policy (config file / env). Still the fallback when no admin policy is published. */
export type PlatformVersionPolicy = {
  /** Minimum version allowed to use the app (force update if client is lower). */
  mandatoryUpdate: string;
  /** Latest recommended version (optional update if client is lower but ≥ mandatory). */
  optionalUpdate: string;
  storeUrl?: string;
};

export type AppVersionConfig = {
  android: PlatformVersionPolicy;
  ios: PlatformVersionPolicy;
  updatedAt: string;
};

/**
 * FORCE: an admin rule blocks this version — show the blocking screen.
 * UNSUPPORTED_DEVICE: the OS is below the platform minimum; an update can't help.
 * STORE: no admin rule applies; the client asks its store (Play priority, App Store bump).
 */
export type UpdateAction = "FORCE" | "UNSUPPORTED_DEVICE" | "STORE";

export type UpdateReason =
  | "OS_TOO_OLD"
  | "BLOCKED_VERSION"
  | "BELOW_FORCE_VERSION"
  | "NONE";

/** Standard mobile client response for update UI. */
export type AppVersionCheckResult = {
  // Legacy fields — the shipped iOS client reads only these. Keep them stable.
  platform: AppPlatform;
  clientVersion: string;
  minimumRequiredVersion: string;
  latestRecommendedVersion: string;
  forceUpdate: boolean;
  optionalUpdate: boolean;
  isUpToDate: boolean;
  storeUrl?: string;

  mode: AppUpdateMode;
  action: UpdateAction;
  reason: UpdateReason;
  latestVersion: string;
  fullyRolledOut: boolean;
  enforceOnServer: boolean;
  store: AndroidStorePolicy | IosStorePolicy;
  title: string | null;
  message: string | null;
  policyVersion: number;
  /** Server time, UTC epoch ms. */
  issuedAt: number;
};
