/**
 * Notification Center taxonomy — the ONE place that decides which bucket a
 * notification `type` belongs to.
 *
 * Two vocabularies live here, on purpose:
 *
 *  - **Catalogue ids** (`FRIEND_REQUEST`, `COMMUNITY`, `MENTION`, `CALLS`,
 *    `SYSTEM`, `LIVE_NOW`) are the shared Android/iOS/Web contract. They are
 *    stable, uppercase, never renamed and never reused, and they are what the
 *    server-driven catalogue (`GET /notifications/categories`) publishes.
 *  - **Legacy tab names** (`FRIENDS`, `COMMUNITIES`, `MENTIONS`) are what
 *    shipped clients send as `?type=` and read back on `NotificationDTO.category`.
 *    They are accepted as aliases forever and `categorize()` still returns them
 *    unchanged, so no released build has to be updated to keep working.
 *
 * `ALL` is NOT a category. It is the clients' no-filter state — always rendered
 * first, never returned by the catalogue endpoint, and `{}` as a query filter.
 *
 * Routing rules (checked in priority order inside categorizeId()):
 *   MENTION        → type ∈ MENTION_TYPES  (checked first so community.mention
 *                    doesn't also match the community.* COMMUNITY branch)
 *   CALLS          → type starts with "call.", or the legacy "CALL_MISSED"
 *   LIVE_NOW       → type ∈ LIVE_TYPES     (checked before COMMUNITY for the
 *                    same reason as MENTION)
 *   FRIEND_REQUEST → type starts with "friend."
 *   COMMUNITY      → type starts with "community." (excluding MENTION/LIVE types)
 *   SYSTEM         → type starts with "auth." or "admin.", or ∈ SYSTEM_VERBATIM
 *
 * Every row lands in EXACTLY ONE bucket, which is what keeps the per-category
 * unread counts from double-counting.
 *
 * Adding a new system notification:
 *   1. Publish it from the producer with a type that starts with "auth." or
 *      "admin." (or add it to SYSTEM_VERBATIM below).
 *   2. Add it to INBOX_ALLOWED_TYPES in notifications-service/push.service.ts.
 *   No changes to this file are needed for auth.* / admin.* types.
 *
 * MENTION currently has no inbox producer; `chat.mention` / `community.mention`
 * are reserved for the mention pipeline that runs push-only with skipInbox.
 * LIVE_NOW is the same shape: the livestream types below are published as push
 * only, so the bucket is defined and filterable but empty until a producer
 * writes one to the inbox.
 */
/**
 * The one notification type that carries the Terminate / It's Me actions.
 * Lives here (env-free lib) so both the repository and the serializer can read
 * it without either importing the other.
 */
export const LOGIN_DETECTED_TYPE = "auth.security_new_login";

/**
 * The fixed catalogue. Seeded by `prisma/seed/notification-categories.seed.ts`,
 * never created or deleted through an API, and never renamed — an id is the
 * localization identity every client keys its label off.
 */
export type NotificationCategoryId =
  | "FRIEND_REQUEST"
  | "COMMUNITY"
  | "MENTION"
  | "CALLS"
  | "SYSTEM"
  | "LIVE_NOW";

export const NOTIFICATION_CATEGORY_IDS: readonly NotificationCategoryId[] = [
  "FRIEND_REQUEST",
  "COMMUNITY",
  "MENTION",
  "CALLS",
  "SYSTEM",
  "LIVE_NOW",
] as const;

/** Client platforms a category can be independently enabled for. */
export type NotificationPlatform = "ANDROID" | "IOS" | "WEB";

export const NOTIFICATION_PLATFORMS: readonly NotificationPlatform[] = [
  "ANDROID",
  "IOS",
  "WEB",
] as const;

export function parsePlatform(raw: unknown): NotificationPlatform | null {
  if (typeof raw !== "string") return null;
  const up = raw.toUpperCase();
  return (NOTIFICATION_PLATFORMS as readonly string[]).includes(up)
    ? (up as NotificationPlatform)
    : null;
}

/**
 * Seed values for the six fixed categories: the priority, English fallback
 * label and icon key a fresh database starts with, and which platforms show
 * the chip. Admins change all four from Super Admin; this is only the
 * starting point, and re-running the seed never overwrites an admin's edit.
 */
export interface NotificationCategorySeed {
  id: NotificationCategoryId;
  priority: number;
  defaultLabel: string;
  iconKey: string;
  enabledPlatforms: NotificationPlatform[];
}

export const NOTIFICATION_CATEGORY_SEED: readonly NotificationCategorySeed[] = [
  {
    id: "FRIEND_REQUEST",
    priority: 1,
    defaultLabel: "Friend Request",
    iconKey: "person_add",
    enabledPlatforms: ["ANDROID", "IOS", "WEB"],
  },
  {
    id: "COMMUNITY",
    priority: 2,
    defaultLabel: "Community",
    iconKey: "groups",
    enabledPlatforms: ["ANDROID", "IOS", "WEB"],
  },
  {
    id: "MENTION",
    priority: 3,
    defaultLabel: "Mention",
    iconKey: "alternate_email",
    enabledPlatforms: ["ANDROID", "IOS", "WEB"],
  },
  {
    id: "CALLS",
    priority: 4,
    defaultLabel: "Calls",
    iconKey: "call",
    enabledPlatforms: ["ANDROID", "IOS", "WEB"],
  },
  {
    id: "SYSTEM",
    priority: 5,
    defaultLabel: "System",
    iconKey: "settings",
    enabledPlatforms: ["ANDROID", "IOS", "WEB"],
  },
  {
    id: "LIVE_NOW",
    priority: 6,
    defaultLabel: "Live Now",
    iconKey: "live_tv",
    enabledPlatforms: ["ANDROID", "IOS", "WEB"],
  },
] as const;

/**
 * The tab names shipped clients still send and read. Frozen: `categorize()`
 * keeps returning these on `NotificationDTO.category`, and `?type=FRIENDS`
 * keeps filtering, forever.
 */
export type NotificationLegacyCategory =
  | "FRIENDS"
  | "COMMUNITIES"
  | "MENTIONS"
  | "CALLS"
  | "SYSTEM";

/** Anything accepted as a filter: no-filter, a catalogue id, or a legacy name. */
export type NotificationCategory =
  | "ALL"
  | NotificationCategoryId
  | NotificationLegacyCategory;

/**
 * Filter token → catalogue id. Legacy names resolve to the id that replaced
 * them; every id resolves to itself. Adding a row here is how an old client's
 * vocabulary keeps working after a rename that never happens to the id itself.
 */
const CATEGORY_ALIASES: Record<string, NotificationCategoryId> = {
  FRIEND_REQUEST: "FRIEND_REQUEST",
  FRIENDS: "FRIEND_REQUEST",
  COMMUNITY: "COMMUNITY",
  COMMUNITIES: "COMMUNITY",
  MENTION: "MENTION",
  MENTIONS: "MENTION",
  CALLS: "CALLS",
  SYSTEM: "SYSTEM",
  LIVE_NOW: "LIVE_NOW",
};

/** Catalogue id → the legacy name `categorize()` reports for it. */
const LEGACY_NAME: Record<NotificationCategoryId, NotificationLegacyCategory> = {
  FRIEND_REQUEST: "FRIENDS",
  COMMUNITY: "COMMUNITIES",
  MENTION: "MENTIONS",
  CALLS: "CALLS",
  SYSTEM: "SYSTEM",
  // Livestream rows kept their legacy bucket: `resolveAvatarRefresh` reads
  // `categorize(type) === "COMMUNITIES"` to decide whether to resolve a fresh
  // community avatar, and a livestream row is still a community row for that
  // purpose. Only `categoryId` — the new field — separates them.
  LIVE_NOW: "COMMUNITIES",
};

export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  "ALL",
  ...NOTIFICATION_CATEGORY_IDS,
] as const;

/**
 * Private 1:1 call history. ONE live type carries every outcome (the outcome
 * itself lives in `data.callStatus`), plus the legacy type of rows written
 * before that projection existed. A group/community call is never projected
 * into the inbox at all, so nothing community-shaped can leak in here.
 */
const CALL_TYPE_PREFIX = "call.";
const CALL_LEGACY_TYPES = ["CALL_MISSED"] as const;

const isCallType = (type: string): boolean =>
  type.startsWith(CALL_TYPE_PREFIX) ||
  (CALL_LEGACY_TYPES as readonly string[]).includes(type);

const MENTION_TYPES = ["chat.mention", "community.mention"] as const;

/**
 * Livestream announcements. Published as push today (they are not in
 * `INBOX_ALLOWED_TYPES`), so this bucket lists nothing yet — but the mapping
 * is here so the day one is written to the inbox it lands under LIVE_NOW
 * instead of being swallowed by the `community.` prefix.
 */
const LIVE_TYPES = [
  "community.livestream_started",
  "community.livestream_ended",
] as const;

/**
 * Verbatim type strings that belong to the SYSTEM category but don't carry an
 * "auth." or "admin." prefix. Keep this list small — prefer the prefix
 * convention for new types.
 */
const SYSTEM_VERBATIM = [
  "ANNOUNCEMENT",
  "MAINTENANCE",
  "UPDATE_REQUIRED",
] as const;

/**
 * Super-Admin announcement. ONE verbatim type, published by
 * `notifications-service/consumers/announcement.consumer.ts` from the
 * backoffice announcement pipeline (`kind: "ANNOUNCEMENT"`).
 */
export const ANNOUNCEMENT_TYPE = "ANNOUNCEMENT";

/**
 * Explicit row category on the wire (`NotificationDTO.category`).
 *
 * This is a SUPERSET of the legacy tab names: an announcement is reported as
 * "Announcement" so clients pick its glyph from an explicit server field
 * instead of pattern-matching the title/body. Filtering and the per-category
 * counts still run off `categoryWhere()`, which is keyed on `type` — an
 * announcement therefore still lists and counts under SYSTEM.
 */
export const ANNOUNCEMENT_ROW_CATEGORY = "Announcement";

export type NotificationRowCategory =
  | NotificationLegacyCategory
  | typeof ANNOUNCEMENT_ROW_CATEGORY;

/**
 * Wire category for a stored row. Announcements are named explicitly; every
 * other type falls through to the legacy bucket, unchanged.
 */
export function rowCategory(type: string): NotificationRowCategory {
  return type === ANNOUNCEMENT_TYPE
    ? ANNOUNCEMENT_ROW_CATEGORY
    : categorize(type);
}

/**
 * Normalize a client's `?type=` to a catalogue id. `null` means "no filter"
 * (`ALL`, absent, or unrecognized) — an unknown token must widen the feed, not
 * empty it.
 */
export function canonicalCategoryId(
  raw: unknown
): NotificationCategoryId | null {
  if (typeof raw !== "string") return null;
  return CATEGORY_ALIASES[raw.toUpperCase()] ?? null;
}

/**
 * Parse a client's `?type=` for the response echo. Returns the token AS SENT
 * (uppercased) when it is recognized, so a client that sent `FRIENDS` reads
 * `FRIENDS` back and one that sent `FRIEND_REQUEST` reads `FRIEND_REQUEST`.
 * Filtering and counting canonicalize separately via `canonicalCategoryId`.
 */
export function parseCategory(raw: unknown): NotificationCategory {
  if (typeof raw !== "string") return "ALL";
  const up = raw.toUpperCase();
  return up in CATEGORY_ALIASES ? (up as NotificationCategory) : "ALL";
}

/** Catalogue id for a stored row — the new, LIVE_NOW-aware bucket. */
export function categorizeId(type: string): NotificationCategoryId {
  // Same policy as an unrecognized type below — a missing one must not throw
  // and abort the notification publish.
  if (typeof type !== "string" || !type) return "SYSTEM";
  // Mentions checked before COMMUNITY so `community.mention` doesn't get
  // swallowed by the `community.` prefix branch.
  if ((MENTION_TYPES as readonly string[]).includes(type)) return "MENTION";
  // Checked before FRIEND_REQUEST: call history has its own bucket, and a row
  // must land in exactly one or the per-category counts double-count it.
  if (isCallType(type)) return "CALLS";
  // Same precedence reason as mentions — livestream types carry the
  // `community.` prefix.
  if ((LIVE_TYPES as readonly string[]).includes(type)) return "LIVE_NOW";
  if (type.startsWith("friend.")) return "FRIEND_REQUEST";
  if (type.startsWith("community.")) return "COMMUNITY";
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
 * Legacy bucket for a stored row — what `NotificationDTO.category` has always
 * reported and what `resolveAvatarRefresh` branches on. Frozen: derived from
 * `categorizeId` so the two can never disagree about a type, then mapped back
 * to the pre-catalogue name.
 */
export function categorize(type: string): NotificationLegacyCategory {
  return LEGACY_NAME[categorizeId(type)];
}

/**
 * Prisma `where` fragment restricting rows to one category. Accepts a
 * catalogue id, a legacy tab name, or `ALL`/anything unrecognized (→ `{}`,
 * no restriction). Uses `startsWith` on the `@@index([userId, type])` — no
 * extra index needed.
 */
export function categoryWhere(
  cat: NotificationCategory
): Record<string, unknown> {
  const id = canonicalCategoryId(cat);
  if (!id) return {};
  switch (id) {
    case "FRIEND_REQUEST":
      return { type: { startsWith: "friend." } };
    case "CALLS":
      return {
        OR: [
          { type: { startsWith: CALL_TYPE_PREFIX } },
          { type: { in: [...CALL_LEGACY_TYPES] } },
        ],
      };
    case "COMMUNITY":
      // `community.mention` belongs to MENTION and the livestream types to
      // LIVE_NOW — exclude both so a row is counted / listed in exactly one
      // category.
      return {
        AND: [
          { type: { startsWith: "community." } },
          { type: { notIn: [...MENTION_TYPES, ...LIVE_TYPES] } },
        ],
      };
    case "MENTION":
      return { type: { in: [...MENTION_TYPES] } };
    case "LIVE_NOW":
      return { type: { in: [...LIVE_TYPES] } };
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
