const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 32;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]+$/;

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
  return (
    username.length >= USERNAME_MIN_LENGTH &&
    username.length <= USERNAME_MAX_LENGTH &&
    USERNAME_PATTERN.test(username)
  );
}

export function usernameWithSuffix(base: string, suffix: number): string {
  const suffixText = `_${String(suffix)}`;
  const maxBaseLength = USERNAME_MAX_LENGTH - suffixText.length;
  return `${base.slice(0, maxBaseLength)}${suffixText}`;
}
