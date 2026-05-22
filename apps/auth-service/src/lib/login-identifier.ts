const EMAIL_LIKE = /@/;

export function isEmailLoginIdentifier(value: string): boolean {
  return EMAIL_LIKE.test(value);
}

/**
 * Normalize the `account` field from a login body (account name or email).
 * Account names are stored lowercase (case-insensitive identity), and emails
 * are always lowercased, so we lowercase both here.
 */
export function normalizeLoginIdentifier(value: string): string {
  return value.trim().toLowerCase();
}
