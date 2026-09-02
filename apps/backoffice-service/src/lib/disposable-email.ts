/**
 * Public disposable-mail domains, refused for admin accounts.
 *
 * The bootstrap super-admin was seeded on `admin@yopmail.com`. yopmail is a
 * service where every inbox is readable by anyone who simply types the address,
 * so the account-recovery path was wide open regardless of the password:
 * request a reset for that address, open the public inbox, read the code,
 * complete the reset — super-admin takeover without ever guessing anything.
 *
 * This list is deliberately small and static. It is not an anti-abuse
 * classifier and does not need to be exhaustive: it exists to stop the highest
 * privilege account on the platform from being anchored to a mailbox that is
 * public by design. Extend it when a real case appears rather than pulling in a
 * dependency that has to be kept current.
 */
const DISPOSABLE_EMAIL_DOMAINS: readonly string[] = [
  "yopmail.com",
  "yopmail.net",
  "yopmail.fr",
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "sharklasers.com",
  "10minutemail.com",
  "temp-mail.org",
  "tempmail.com",
  "throwawaymail.com",
  "trashmail.com",
  "getnada.com",
  "dispostable.com",
  "maildrop.cc",
  "fakeinbox.com",
  "mohmal.com",
];

/**
 * True when the address belongs to a public disposable-mail service, or to a
 * subdomain of one (several offer per-user subdomains).
 */
export function isDisposableEmail(email: string): boolean {
  const at = email.trim().toLowerCase().lastIndexOf("@");
  if (at === -1) return false;
  const domain = email
    .trim()
    .toLowerCase()
    .slice(at + 1)
    .replace(/\.$/, "");
  return DISPOSABLE_EMAIL_DOMAINS.some(
    (blocked) => domain === blocked || domain.endsWith(`.${blocked}`)
  );
}
