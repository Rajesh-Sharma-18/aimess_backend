import type {
  AndroidStorePolicy,
  AppUpdatePolicy,
  IosStorePolicy,
} from "@aimess/redis";

import { compareVersions } from "./compare-version.js";
import { parseAppVersion } from "./version-format.js";
import type {
  AppVersionConfig,
  UpdateAction,
  UpdateReason,
} from "./types.js";

export const DEFAULT_ANDROID_STORE: AndroidStorePolicy = {
  forceFromPriority: 4,
  softFromPriority: 2,
  escalateSoftAfterDays: null,
};

// Off until an admin opts in: a version-bump rule decides force for every iOS
// user, so it must never switch itself on.
export const DEFAULT_IOS_STORE: IosStorePolicy = {
  appStoreId: null,
  forceOnBump: "OFF",
  softOnBump: "OFF",
};

type PlatformPolicy = AppUpdatePolicy["android"] | AppUpdatePolicy["ios"];

/**
 * The admin rungs of the update ladder; first match wins. Store rungs run on the
 * device (only it can ask Play or the App Store), so anything not decided here is
 * returned as STORE.
 */
export function resolveUpdateAction(
  policy: PlatformPolicy,
  clientVersion: string,
  osLevel?: number
): { action: UpdateAction; reason: UpdateReason } {
  if (
    policy.minOsLevel != null &&
    osLevel != null &&
    osLevel < policy.minOsLevel
  ) {
    return { action: "UNSUPPORTED_DEVICE", reason: "OS_TOO_OLD" };
  }

  // A version's own rule beats the platform default in both directions: it can
  // force one version under a store-managed default, or exempt one version
  // from the default's force floor.
  const rule = policy.versionRules?.find(
    (r) => compareVersions(r.version, clientVersion) === 0
  );
  if (rule) {
    return rule.mode === "ADMIN_MANAGED" && rule.forceUpdate
      ? { action: "FORCE", reason: "BLOCKED_VERSION" }
      : { action: "STORE", reason: "NONE" };
  }

  if (policy.mode === "STORE_MANAGED") {
    return { action: "STORE", reason: "NONE" };
  }

  if (
    policy.blockedVersions.some(
      (blocked) => compareVersions(blocked, clientVersion) === 0
    )
  ) {
    return { action: "FORCE", reason: "BLOCKED_VERSION" };
  }

  if (
    policy.forceBelowVersion &&
    compareVersions(clientVersion, policy.forceBelowVersion) < 0
  ) {
    return { action: "FORCE", reason: "BELOW_FORCE_VERSION" };
  }

  return { action: "STORE", reason: "NONE" };
}

/** Maps the legacy file/env config onto the policy shape, preserving its behaviour exactly. */
export function fromLegacyConfig(config: AppVersionConfig): AppUpdatePolicy {
  const platform = (legacy: AppVersionConfig["android"]) => {
    const minimum = parseAppVersion(legacy.mandatoryUpdate).canonical;
    const optional = parseAppVersion(legacy.optionalUpdate).canonical;
    return {
      mode: "ADMIN_MANAGED" as const,
      forceBelowVersion: minimum,
      blockedVersions: [],
      latestVersion:
        compareVersions(optional, minimum) < 0 ? minimum : optional,
      fullyRolledOut: true,
      minOsLevel: null,
      storeUrl: legacy.storeUrl ?? null,
      enforceOnServer: false,
      copy: {},
    };
  };

  return {
    android: { ...platform(config.android), store: DEFAULT_ANDROID_STORE },
    ios: { ...platform(config.ios), store: DEFAULT_IOS_STORE },
    policyVersion: 0,
    updatedAt: config.updatedAt,
  };
}
