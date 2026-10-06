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
