const EMAIL_LIKE = /@/;

export function isEmailLoginIdentifier(value: string): boolean {
  return EMAIL_LIKE.test(value);
}

/**
 * Normalize the `account` field from a login body (account name or email).
 *
 * Emails are lowercased, because every path that STORES one lowercases it
 * (`normalizeEmail`) and the lookup is an exact-match unique index — without
 * this, a user who linked name@example.com and then typed Name@Example.com was
 * told their credentials were invalid.
 *
 * Account names are NOT lowercased. They are stored with the case the user
 * chose (see `accountSchema`, whose `.toLowerCase()` is commented out), so
 * folding them here would break username login for every mixed-case handle.
 */
export function normalizeLoginIdentifier(value: string): string {
  const trimmed = value.trim();
  return isEmailLoginIdentifier(trimmed) ? trimmed.toLowerCase() : trimmed;
}
