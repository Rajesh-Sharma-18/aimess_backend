export const APP_PLATFORMS = ["android", "ios"] as const;

export type AppPlatform = (typeof APP_PLATFORMS)[number];

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

/** Standard mobile client response for update UI. */
export type AppVersionCheckResult = {
  platform: AppPlatform;
  clientVersion: string;
  minimumRequiredVersion: string;
  latestRecommendedVersion: string;
  forceUpdate: boolean;
  optionalUpdate: boolean;
  isUpToDate: boolean;
  storeUrl?: string;
};
