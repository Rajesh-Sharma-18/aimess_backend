import type { AppUpdatePolicy, VersionRule } from "@aimess/redis";

import type { AppUpdatePolicyInput } from "../api/validators/index.js";

type PlatformPolicy = AppUpdatePolicy["android"] | AppUpdatePolicy["ios"];
type PlatformInput =
  | AppUpdatePolicyInput["android"]
  | AppUpdatePolicyInput["ios"];

// "02.0.3" and "2.0.3" are one version; rules are keyed by the canonical form.
const canonical = (version: string) =>
  version.trim().split(".").map(Number).join(".");

const compareDesc = (a: VersionRule, b: VersionRule) => {
  const x = a.version.split(".").map(Number);
  const y = b.version.split(".").map(Number);
  return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
};

/** A policy saved before per-version rules: its blocked versions are its rules. */
export function rulesOf(
  policy: PlatformPolicy,
  fallbackAt: number
): VersionRule[] {
  return (
    policy.versionRules ??
    policy.blockedVersions.map((version) => ({
      version: canonical(version),
      mode: "ADMIN_MANAGED" as const,
      forceUpdate: true,
      updatedAt: fallbackAt,
    }))
  );
}

/**
 * The stored platform policy for an input. `versionRules` is the source of
 * truth; `blockedVersions` is re-derived from it so an older gateway still
 * forces exactly the same versions. A rule keeps its `updatedAt` unless its
 * mode or force flag changed. An input without `versionRules` (an admin client
 * that predates them) keeps the old blockedVersions meaning.
 */
export function withVersionRules<P extends PlatformInput>(
  input: P,
  previous: PlatformPolicy | undefined,
  previousAt: number,
  now: number
): P & { versionRules: VersionRule[]; blockedVersions: string[] } {
  const before = previous ? rulesOf(previous, previousAt) : [];
  const incoming =
    input.versionRules ??
    input.blockedVersions.map((version) => ({
      version,
      mode: "ADMIN_MANAGED" as const,
      forceUpdate: true,
    }));
  const versionRules = incoming
    .map((rule) => {
      const version = canonical(rule.version);
      // A store-managed rule has no force; normalise so it compares equal.
      const forceUpdate = rule.mode === "ADMIN_MANAGED" && rule.forceUpdate;
      const prev = before.find((r) => r.version === version);
      const unchanged =
        prev && prev.mode === rule.mode && prev.forceUpdate === forceUpdate;
      return {
        version,
        mode: rule.mode,
        forceUpdate,
        updatedAt: unchanged ? prev.updatedAt : now,
      };
    })
    .sort(compareDesc);
  return {
    ...input,
    versionRules,
    blockedVersions: versionRules
      .filter((r) => r.forceUpdate)
      .map((r) => r.version),
  };
}
