import { createHash } from "node:crypto";

/**
 * What a purged account looks like.
 *
 * Deleting an account erased and overwrote nothing: `deletedAt` was stamped,
 * sessions were revoked, and every column — email, phone, password hash, the
 * Google/Apple identities, the profile — was retained in full and indefinitely.
 * `scheduledDeletionAt` recorded a 30-day grace period that no job read. The
 * "Deleted Account" name users saw was a read-time projection over live data.
 *
 * Purging replaces the identifying values rather than dropping the row. The row
 * has to survive because the rest of the platform references its id from
 * messages, memberships and audit records, and deleting it would either cascade
 * those away or leave dangling references. What must not survive is anything
 * that identifies a person.
 *
 * The placeholders are DERIVED from the user id, not random, so they are:
 *  - stable, if a purge is ever re-run for the same account;
 *  - unique, so they satisfy the unique indexes on `account`, `email` and
 *    `phone` without colliding with another purged row;
 *  - and not reversible into the original address.
 */

/** Short, stable, non-reversible tag for a purged account's placeholders. */
function purgeTag(userId: string): string {
  return createHash("sha256")
    .update(`aimess:purge:${userId}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * The values that replace an account's identifying columns.
 *
 * `account` is included because it is a login handle chosen by the user and
 * often their real name or a handle they use elsewhere — leaving it behind
 * would defeat the purge on its own.
 */
export function anonymizedAccountFields(userId: string): {
  account: string;
  email: null;
  phone: null;
  passwordHash: null;
  dateOfBirth: null;
  fcmTokens: string[];
  emailVerified: false;
  phoneVerified: false;
} {
  return {
    account: `deleted_${purgeTag(userId)}`,
    // Nulled rather than replaced: nothing should be able to send mail or SMS
    // to a purged account, and a placeholder address risks exactly that.
    email: null,
    phone: null,
    // The hash is a credential. It is also a target for offline cracking
    // against password reuse elsewhere, so it must not outlive the account.
    passwordHash: null,
    dateOfBirth: null,
    // Push tokens address a physical device; keeping them would let a purged
    // account still receive notifications.
    fcmTokens: [],
    emailVerified: false,
    phoneVerified: false,
  };
}

/**
 * Placeholder for a linked provider identity.
 *
 * `providerUserId` is the Google/Apple `sub` — a stable identifier for a real
 * person at that provider, and the value the by-provider lookup matches on. It
 * must be replaced, not just blanked, because the column is part of a unique
 * index and because leaving it would let the same person's next sign-in silently
 * re-attach to the purged account.
 */
export function anonymizedLinkedAccountFields(
  userId: string,
  linkedAccountId: string
): { providerUserId: string; email: null; displayName: null } {
  return {
    providerUserId: `purged:${purgeTag(userId)}:${linkedAccountId}`,
    email: null,
    displayName: null,
  };
}
