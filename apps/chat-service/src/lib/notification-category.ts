/**
 * Notification Center tab taxonomy. The Notification page has 5 tabs — ALL,
 * FRIENDS, COMMUNITIES, MENTIONS, SYSTEM — and the REST endpoint filters +
 * counts by these buckets. Event type strings use the domain-namespaced form
 * from `@aimess/shared-types` (`friend.*`, `community.*`, `auth.*`, ...) so
 * prefix routing is enough — no per-type maintenance.
 *
 * MENTIONS currently has no producer; `chat.mention` / `community.mention` are
 * reserved for the mention pipeline that today runs push-only with skipInbox.
 * Reserved so adding the type later needs no re-plumbing here.
 */
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

export function parseCategory(raw: unknown): NotificationCategory {
  if (typeof raw !== "string") return "ALL";
  const up = raw.toUpperCase();
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(up)
    ? (up as NotificationCategory)
    : "ALL";
}

export function categorize(type: string): Exclude<NotificationCategory, "ALL"> {
  // Mentions checked before COMMUNITIES so `community.mention` doesn't get
  // swallowed by the `community.` prefix branch.
  if ((MENTION_TYPES as readonly string[]).includes(type)) return "MENTIONS";
  if (type.startsWith("friend.")) return "FRIENDS";
  if (type.startsWith("community.")) return "COMMUNITIES";
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
      return { type: { startsWith: "friend." } };
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
      // Everything that isn't friend/community/mention. This intentionally
      // catches auth.*, admin.*, session.*, user.registered, and anything
      // new that lands without a dedicated tab.
      return {
        NOT: [
          { type: { startsWith: "friend." } },
          { type: { startsWith: "community." } },
          { type: { in: [...MENTION_TYPES] } },
        ],
      };
  }
}
