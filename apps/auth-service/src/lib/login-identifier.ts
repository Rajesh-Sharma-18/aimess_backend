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
 * Account names are NOT lowercased here. New ones are stored lowercase, but
 * legacy ones keep their original case, and a few legacy pairs differ ONLY by
 * case — the repository matches exact-case first, then case-insensitively
 * (`findByAccountForLogin`), which needs the spelling as typed.
 */
export function normalizeLoginIdentifier(value: string): string {
  const trimmed = value.trim();
  return isEmailLoginIdentifier(trimmed) ? trimmed.toLowerCase() : trimmed;
}
