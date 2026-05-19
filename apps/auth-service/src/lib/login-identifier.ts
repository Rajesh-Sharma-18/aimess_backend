const EMAIL_LIKE = /@/;

export function isEmailLoginIdentifier(value: string): boolean {
  return EMAIL_LIKE.test(value);
}

/** Normalize `account` field from login body (username or email). */
export function normalizeLoginIdentifier(value: string): string {
  const trimmed = value.trim();
  return isEmailLoginIdentifier(trimmed) ? trimmed.toLowerCase() : trimmed;
}
