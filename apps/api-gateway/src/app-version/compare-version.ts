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
