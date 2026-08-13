/**
 * Notification Center tab taxonomy. The Notification page has 5 tabs — ALL,
 * FRIENDS, COMMUNITIES, MENTIONS, SYSTEM — and the REST endpoint filters +
 * counts by these buckets.
 *
 * Routing rules (checked in priority order inside categorize()):
 *   MENTIONS    → type ∈ MENTION_TYPES  (checked first so community.mention
 *                 doesn't also match the community.* COMMUNITIES branch)
 *   FRIENDS     → type starts with "friend."
 *   COMMUNITIES → type starts with "community." (excluding MENTION_TYPES)
 *   SYSTEM      → type starts with "auth." or "admin.", or ∈ SYSTEM_VERBATIM
 *
 * Adding a new system notification:
 *   1. Publish it from the producer with a type that starts with "auth." or
 *      "admin." (or add it to SYSTEM_VERBATIM below).
 *   2. Add it to INBOX_ALLOWED_TYPES in notifications-service/push.service.ts.
 *   No changes to this file are needed for auth.* / admin.* types.
 *
 * MENTIONS currently has no inbox producer; `chat.mention` / `community.mention`
 * are reserved for the mention pipeline that runs push-only with skipInbox.
 */
/**
 * The one notification type that carries the Terminate / It's Me actions.
 * Lives here (env-free lib) so both the repository and the serializer can read
 * it without either importing the other.
 */
export const LOGIN_DETECTED_TYPE = "auth.security_new_login";

export type NotificationCategory =
  | "ALL"
  | "FRIENDS"
  | "COMMUNITIES"
  | "MENTIONS"
  | "SYSTEM";

export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  "ALL",
  "FRIENDS",
  "COMMUNITIES",
  "MENTIONS",
  "SYSTEM",
] as const;

const MENTION_TYPES = ["chat.mention", "community.mention"] as const;

/**
 * Verbatim type strings that belong to the SYSTEM tab but don't carry an
 * "auth." or "admin." prefix. Keep this list small — prefer the prefix
 * convention for new types.
 */
const SYSTEM_VERBATIM = [
  "ANNOUNCEMENT",
  "MAINTENANCE",
  "UPDATE_REQUIRED",
] as const;

export function parseCategory(raw: unknown): NotificationCategory {
  if (typeof raw !== "string") return "ALL";
  const up = raw.toUpperCase();
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(up)
    ? (up as NotificationCategory)
    : "ALL";
}

export function categorize(type: string): Exclude<NotificationCategory, "ALL"> {
  // Same policy as an unrecognized type below — a missing one must not throw
  // and abort the notification publish.
  if (typeof type !== "string" || !type) return "SYSTEM";
  // Mentions checked before COMMUNITIES so `community.mention` doesn't get
  // swallowed by the `community.` prefix branch.
  if ((MENTION_TYPES as readonly string[]).includes(type)) return "MENTIONS";
  if (type.startsWith("friend.") || type === "CALL_MISSED") return "FRIENDS";
  if (type.startsWith("community.")) return "COMMUNITIES";
  if (
    type.startsWith("auth.") ||
    type.startsWith("admin.") ||
    (SYSTEM_VERBATIM as readonly string[]).includes(type)
  )
    return "SYSTEM";
  // Unknown types fall to SYSTEM so they surface somewhere visible rather than
  // disappearing, but they won't reach the inbox unless added to INBOX_ALLOWED_TYPES.
  return "SYSTEM";
}

/**
 * Prisma `where` fragment restricting rows to the given category. Uses
 * `startsWith` on the `@@index([userId, type])` — no extra index needed.
 * ALL → `{}` (no restriction).
 */
export function categoryWhere(
  cat: NotificationCategory
): Record<string, unknown> {
  switch (cat) {
    case "ALL":
      return {};
    case "FRIENDS":
      return {
        OR: [
          { type: { startsWith: "friend." } },
          { type: { in: ["CALL_MISSED"] } },
        ],
      };
    case "COMMUNITIES":
      // `community.mention` belongs to MENTIONS — exclude it from COMMUNITIES
      // so a row is counted / listed in exactly one tab.
      return {
        AND: [
          { type: { startsWith: "community." } },
          { type: { notIn: [...MENTION_TYPES] } },
        ],
      };
    case "MENTIONS":
      return { type: { in: [...MENTION_TYPES] } };
    case "SYSTEM":
      // Explicit inclusion: only auth.* (security/account events) and admin.*
      // (ban/suspend/unban) prefixes, plus the small verbatim set above.
      // Using an allowlist instead of a catch-all exclusion prevents community
      // notifications stored with non-standard type strings from leaking here.
      return {
        OR: [
          { type: { startsWith: "auth." } },
          { type: { startsWith: "admin." } },
          { type: { in: [...SYSTEM_VERBATIM] } },
        ],
      };
  }
}
