import { t } from "./i18n.js";
import type { SupportedLocale } from "./locale.js";
import type { MessageKey } from "./messages/index.js";

/**
 * THE sentence for a member being added to / removed from a group or community:
 *
 *   "{actor} added {target} to {entity}"
 *   "{actor} removed {target} from {entity}"
 *
 * Every surface that shows one of these events renders through here — the
 * group and community chat lines, the list previews built from them, the push,
 * and the Notification Center row — so they cannot drift into different
 * wording for the same event.
 *
 * Nothing viewer-specific is ever stored: callers pass ids + names captured at
 * event time, and the reader's userId at RENDER time decides which side (if
 * any) reads "You".
 */
export type MemberChange = "ADDED" | "REMOVED";

export type EntityKind = "GROUP" | "COMMUNITY";

/**
 * Actor id for an automated action no person performed (the auto-unmute
 * sweeper). Renders as "System" for every reader.
 */
export const SYSTEM_ACTOR_ID = "system";

/** "System" — see {@link SYSTEM_ACTOR_ID}. */
export const systemActorLabel = (locale: SupportedLocale): string =>
  t("SYS_NAME_SYSTEM", locale);

/**
 * Actor id for an action a Super Admin performed from Backoffice. The admin is
 * not an AIMess user, so their name and admin id never reach a client: every
 * reader sees "Administrator", and nobody reads it as "You". Their real identity
 * lives in the Backoffice audit log only.
 */
export const PLATFORM_ADMIN_ACTOR_ID = "platform_admin";

/**
 * `source` value marking a system line / event as Backoffice-originated. Already
 * stamped on community ban/unban lines, so legacy rows carry it too.
 */
export const BACKOFFICE_SOURCE = "BO";

/** "Administrator" — see {@link PLATFORM_ADMIN_ACTOR_ID}. */
export const administratorActorLabel = (locale: SupportedLocale): string =>
  t("SYS_NAME_ADMINISTRATOR", locale);

/**
 * "Admin" / "Moderator" for an actor who acted in that role (an owner is the
 * admin), null for anyone else, so the caller keeps the person's name.
 */
export function roleActorLabel(
  role: unknown,
  locale: SupportedLocale
): string | null {
  const r = String(role ?? "").trim().toUpperCase();
  if (r === "ADMIN" || r === "OWNER") return t("SYS_NAME_ROLE_ADMIN", locale);
  if (r === "MODERATOR") return t("SYS_NAME_ROLE_MODERATOR", locale);
  return null;
}

/**
 * One side of the sentence from the reader's point of view: the reader's own
 * userId renders as "You", {@link SYSTEM_ACTOR_ID} as "System",
 * {@link PLATFORM_ADMIN_ACTOR_ID} as "Administrator", anyone else by
 * the name captured at event time, and an unresolved name by the caller's
 * existing fallback ("Someone" / "A member"). Compared on the canonical AIMess
 * userId — never a device or session — so every device of one account reads
 * "You".
 */
export function personLabel(
  userId: string | null | undefined,
  name: string | null | undefined,
  viewerId: string | null | undefined,
  locale: SupportedLocale,
  fallback: MessageKey = "SYS_NAME_SOMEONE"
): string {
  if (userId === SYSTEM_ACTOR_ID) return systemActorLabel(locale);
  if (userId === PLATFORM_ADMIN_ACTOR_ID) return administratorActorLabel(locale);
  const viewer = viewerId?.trim();
  if (userId && viewer && userId === viewer) return t("SYS_SENDER_YOU", locale);
  return name?.trim() || t(fallback, locale);
}

/** The group/community name, or "the group"/"the community" for a row that never stored one. */
export function entityLabel(
  name: string | null | undefined,
  kind: EntityKind,
  locale: SupportedLocale
): string {
  return (
    name?.trim() ||
    t(
      kind === "GROUP" ? "SYS_ENTITY_THE_GROUP" : "SYS_ENTITY_THE_COMMUNITY",
      locale
    )
  );
}

/** Assemble the sentence from already-resolved labels. */
export function memberChangeText(
  change: MemberChange,
  labels: { actor: string; target: string; entity: string },
  locale: SupportedLocale
): string {
  return t(
    change === "ADDED" ? "SYS_MEMBER_ADDED_TO" : "SYS_MEMBER_REMOVED_FROM",
    locale,
    labels
  );
}

/**
 * How many names a grouped system line spells out before collapsing the rest
 * into "and N others" (WhatsApp behaviour — a 50-member add must not render a
 * 50-name bubble).
 */
const GROUPED_NAME_LIMIT = 3;

/** "A", "A and B", "A, B and C", "A, B, C and 3 others". */
export function formatNameList(labels: string[], locale: SupportedLocale): string {
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0]!;
  if (labels.length <= GROUPED_NAME_LIMIT) {
    return t("SYS_LIST_AND", locale, {
      a: labels.slice(0, -1).join(", "),
      b: labels[labels.length - 1]!,
    });
  }
  const rest = labels.length - GROUPED_NAME_LIMIT;
  return t(
    rest === 1 ? "SYS_LIST_OTHERS_ONE" : "SYS_LIST_OTHERS_OTHER",
    locale,
    {
      list: labels.slice(0, GROUPED_NAME_LIMIT).join(", "),
      count: rest,
    }
  );
}

/**
 * Display labels for a BATCH system line's `targetUserIds` / `targetNames`
 * (one add-member operation ⇒ one row), or null when the row is the classic
 * single-target shape. The viewer, if they are one of the targets, is rendered
 * as "You" and hoisted to the front so they still see themselves named even
 * when the list overflows into "and N others".
 */
export function groupedTargetLabels(
  data: Record<string, unknown>,
  viewer: string,
  locale: SupportedLocale
): string[] | null {
  const rawIds = data.targetUserIds;
  if (!Array.isArray(rawIds) || rawIds.length < 2) return null;
  const names = Array.isArray(data.targetNames) ? data.targetNames : [];
  const entries = rawIds.map((id, i) => ({
    id: String(id),
    label: String(names[i] ?? "").trim() || t("SYS_NAME_A_MEMBER", locale),
  }));
  const viewerIndex = viewer
    ? entries.findIndex((entry) => entry.id === viewer)
    : -1;
  if (viewerIndex >= 0) {
    const [self] = entries.splice(viewerIndex, 1);
    self!.label = t("SYS_SENDER_YOU", locale);
    entries.unshift(self!);
  }
  return entries.map((entry) => entry.label);
}
