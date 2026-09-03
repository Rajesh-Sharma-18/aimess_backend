import { createHash } from "node:crypto";

/**
 * A log-safe reference to an email address.
 *
 * Transactional mail is the single path for every registration, password-reset,
 * link-email and change-email OTP, and each send logged the raw recipient at
 * info level. That turned the production log into a running roster of user
 * email addresses correlated with the security action that produced them
 * ("password reset requested for alice@example.com at 14:02"). Logs are
 * retained, shipped to aggregators and read by staff who have no need for that
 * data, so a log dump disclosed the user list.
 *
 * The digest is stable, so a support engineer can still correlate every line
 * about one recipient, and the domain is kept because deliverability triage is
 * a per-domain question ("is Gmail bouncing us?"). Neither is reversible into
 * the local part.
 */
export function maskEmailForLog(email: string): string {
  const normalized = email.trim().toLowerCase();
  const digest = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 12);
  const domain = normalized.includes("@")
    ? normalized.slice(normalized.lastIndexOf("@") + 1)
    : "unknown";
  return `${digest}@${domain}`;
}
