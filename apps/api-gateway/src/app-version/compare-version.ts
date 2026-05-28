import type { ParsedAppVersion } from "./version-format.js";
import { parseAppVersion } from "./version-format.js";

function compareParsed(
  left: ParsedAppVersion,
  right: ParsedAppVersion
): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

/** Compare semver-like `major.minor.patch` strings. Returns -1, 0, or 1. */
export function compareVersions(left: string, right: string): number {
  return compareParsed(parseAppVersion(left), parseAppVersion(right));
}

export type AppUpdateFlags = {
  /** Block app — client is below minimum required version. */
  forceUpdate: boolean;
  /** Show dismissible update prompt — client is supported but below latest. */
  optionalUpdate: boolean;
  /** No update UI — client is on or above latest recommended version. */
  isUpToDate: boolean;
};

export function resolveUpdateFlags(
  clientVersion: string,
  minimumRequiredVersion: string,
  latestRecommendedVersion: string
): AppUpdateFlags {
  const client = parseAppVersion(clientVersion);
  const minimum = parseAppVersion(minimumRequiredVersion);
  const latest = parseAppVersion(latestRecommendedVersion);

  if (compareParsed(client, minimum) < 0) {
    return {
      forceUpdate: true,
      optionalUpdate: false,
      isUpToDate: false,
    };
  }

  if (compareParsed(client, latest) < 0) {
    return {
      forceUpdate: false,
      optionalUpdate: true,
      isUpToDate: false,
    };
  }

  return {
    forceUpdate: false,
    optionalUpdate: false,
    isUpToDate: true,
  };
}
