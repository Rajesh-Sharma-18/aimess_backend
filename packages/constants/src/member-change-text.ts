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
 * Actor id for an action no AIMess user performed — a platform (Super) Admin
 * adding or removing a member. Renders as "System" for every reader. The same
 * sentinel community lines already use for the auto-unmute sweeper.
 */
export const SYSTEM_ACTOR_ID = "system";

/** "System" — see {@link SYSTEM_ACTOR_ID}. */
export const systemActorLabel = (locale: SupportedLocale): string =>
  t("SYS_NAME_SYSTEM", locale);

/**
 * One side of the sentence from the reader's point of view: the reader's own
 * userId renders as "You", {@link SYSTEM_ACTOR_ID} as "System", anyone else by
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
