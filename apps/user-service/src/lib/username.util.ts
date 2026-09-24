import { TEXT_NAME_MAX_LENGTH } from "@aimess/constants";

const USERNAME_MIN_LENGTH = 3;
// 30, shared with every other short identity field and with the website — see
// TEXT_NAME_MAX_LENGTH. Only the CEILING moved (it was 32); the floor, the
// lowercase normalization and the [a-z0-9_] rule are unchanged, and nothing
// here is applied to a username being LOOKED UP, so the handful of legacy
// 31-32 character profiles keep resolving.
const USERNAME_MAX_LENGTH = TEXT_NAME_MAX_LENGTH;
/** Canonical usernames are stored lowercase so uniqueness matches user expectations. */
const USERNAME_PATTERN = /^[a-z0-9_]+$/;

/** Trim + lowercase — call before format checks and DB lookups. */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** Normalize auth `account` into a valid username base (lowercase, safe chars). */
export function usernameBaseFromAccount(account: string): string {
  const normalized = account
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (normalized.length < USERNAME_MIN_LENGTH) {
    return normalized.padEnd(USERNAME_MIN_LENGTH, "_");
  }

  return normalized.slice(0, USERNAME_MAX_LENGTH);
}

export function isValidUsernameFormat(username: string): boolean {
  const normalized = normalizeUsername(username);
  return (
    normalized.length >= USERNAME_MIN_LENGTH &&
    normalized.length <= USERNAME_MAX_LENGTH &&
    USERNAME_PATTERN.test(normalized)
  );
}

export function usernameWithSuffix(base: string, suffix: number): string {
  const suffixText = `_${String(suffix)}`;
  const maxBaseLength = USERNAME_MAX_LENGTH - suffixText.length;
  return `${base.slice(0, maxBaseLength)}${suffixText}`;
}
