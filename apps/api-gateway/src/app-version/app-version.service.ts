import type { AppVersionStore } from "./app-version.store.js";
import { compareVersions, resolveUpdateFlags } from "./compare-version.js";
import { parseAppVersion } from "./version-format.js";
import type { AppPlatform, AppVersionCheckResult } from "./types.js";
import type { PlatformVersionPolicy } from "./types.js";

export type CheckAppVersionInput = {
  platform: AppPlatform;
  version: string;
};

function normalizePolicy(policy: PlatformVersionPolicy): PlatformVersionPolicy {
  const minimum = parseAppVersion(policy.mandatoryUpdate).canonical;
  let latest = parseAppVersion(policy.optionalUpdate).canonical;

  if (compareVersions(latest, minimum) < 0) {
    latest = minimum;
  }

  return {
    mandatoryUpdate: minimum,
    optionalUpdate: latest,
    storeUrl: policy.storeUrl,
  };
}

export function createAppVersionService(store: AppVersionStore) {
  return {
    async check(input: CheckAppVersionInput): Promise<AppVersionCheckResult> {
      const config = await store.get();
      const policy = normalizePolicy(config[input.platform]);
      const clientVersion = parseAppVersion(input.version).canonical;

      const flags = resolveUpdateFlags(
        clientVersion,
        policy.mandatoryUpdate,
        policy.optionalUpdate
      );

      return {
        platform: input.platform,
        clientVersion,
        minimumRequiredVersion: policy.mandatoryUpdate,
        latestRecommendedVersion: policy.optionalUpdate,
        ...flags,
        storeUrl: policy.storeUrl,
      };
    },
  };
}
