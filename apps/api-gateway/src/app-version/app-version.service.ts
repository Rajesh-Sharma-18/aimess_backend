import type { AppUpdatePolicy } from "@aimess/redis";

import type { AppVersionStore } from "./app-version.store.js";
import { compareVersions } from "./compare-version.js";
import { fromLegacyConfig, resolveUpdateAction } from "./resolve-update.js";
import { parseAppVersion } from "./version-format.js";
import type { AppPlatform, AppVersionCheckResult } from "./types.js";

export type CheckAppVersionInput = {
  platform: AppPlatform;
  version: string;
  osLevel?: number;
  locale?: string;
};

// Bounds how stale a gateway node can be after an admin publishes. The gate runs
// on every request, so this also caps Redis reads to one per node per window.
const POLICY_TTL_MS = 10_000;

export function createAppVersionService(
  store: AppVersionStore,
  readPublished: () => Promise<AppUpdatePolicy | null>,
  now: () => number = Date.now
) {
  let hot: { policy: AppUpdatePolicy; at: number } | null = null;

  async function currentPolicy(): Promise<AppUpdatePolicy> {
    if (hot && now() - hot.at < POLICY_TTL_MS) return hot.policy;
    // Redis down or never published → the static file/env policy, never an error.
    const published = await readPublished().catch(() => null);
    const policy = published ?? fromLegacyConfig(await store.get());
    hot = { policy, at: now() };
    return policy;
  }

  async function check(
    input: CheckAppVersionInput
  ): Promise<AppVersionCheckResult> {
    const policy = await currentPolicy();
    const platformPolicy = policy[input.platform];
    const clientVersion = parseAppVersion(input.version).canonical;
    const { action, reason } = resolveUpdateAction(
      platformPolicy,
      clientVersion,
      input.osLevel
    );

    const forceUpdate = action === "FORCE";
    const optionalUpdate =
      action === "STORE" &&
      compareVersions(clientVersion, platformPolicy.latestVersion) < 0;
    const copy =
      (input.locale && platformPolicy.copy[input.locale]) ||
      platformPolicy.copy.en ||
      {};

    return {
      platform: input.platform,
      clientVersion,
      minimumRequiredVersion:
        platformPolicy.mode === "ADMIN_MANAGED" &&
        platformPolicy.forceBelowVersion
          ? platformPolicy.forceBelowVersion
          : "0.0.0",
      latestRecommendedVersion: platformPolicy.latestVersion,
      forceUpdate,
      optionalUpdate,
      isUpToDate: action === "STORE" && !optionalUpdate,
      storeUrl: platformPolicy.storeUrl ?? undefined,

      mode: platformPolicy.mode,
      action,
      reason,
      latestVersion: platformPolicy.latestVersion,
      fullyRolledOut: platformPolicy.fullyRolledOut,
      enforceOnServer: platformPolicy.enforceOnServer,
      store: platformPolicy.store,
      title: copy.title ?? null,
      message: copy.message ?? null,
      policyVersion: policy.policyVersion,
      issuedAt: now(),
    };
  }

  return {
    check,

    /**
     * The check result when this client must be refused by the server gate, else
     * `null`. Only admin FORCE with `enforceOnServer` qualifies — a store decision
     * is the client's alone. Anything unparsable fails open.
     */
    async refusal(
      platform: string | undefined,
      version: string | undefined
    ): Promise<AppVersionCheckResult | null> {
      const normalized = platform?.toLowerCase();
      if ((normalized !== "android" && normalized !== "ios") || !version) {
        return null;
      }
      try {
        const result = await check({ platform: normalized, version });
        return result.action === "FORCE" && result.enforceOnServer
          ? result
          : null;
      } catch {
        return null;
      }
    },
  };
}

export type AppVersionService = ReturnType<typeof createAppVersionService>;
