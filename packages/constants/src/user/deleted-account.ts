/**
 * The one display identity every service renders for a deleted account.
 *
 * A deleted account is never removed from the database (see auth-service
 * `account-deletion.service.ts` — the delete is soft, always), so its userId
 * keeps appearing wherever history must survive: private conversations, group
 * and community member rows, message senders, quoted replies, reactions,
 * pinned messages, read receipts. Every one of those surfaces resolves the
 * name through a single chokepoint per service, and every one of those
 * chokepoints substitutes this string once the profile reports `isDeleted`.
 *
 * Deliberately NOT localized on the server. Identity is resolved deep inside
 * batch serializers that carry no locale (unlike system messages, which are
 * rendered per recipient), and the alternative — an empty name plus a flag —
 * would leave every client that has not shipped deleted-account support
 * rendering a blank row. Responses therefore carry BOTH this literal AND an
 * `isDeleted` boolean: old clients show readable English, new clients localize
 * off the flag and additionally suppress profile navigation / member actions.
 */
export const DELETED_ACCOUNT_DISPLAY_NAME = "Deleted Account";
