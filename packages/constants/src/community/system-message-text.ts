import { t } from "../i18n.js";
import { STORED_TEXT_LOCALE, type SupportedLocale } from "../locale.js";
import { currentTimeZone } from "../locale-context.js";
import { formatDurationShort, formatViewerDateTime } from "../time-format.js";
import {
  administratorActorLabel,
  BACKOFFICE_SOURCE,
  entityLabel,
  formatNameList,
  groupedTargetLabels,
  memberChangeText,
  namedActorLabel,
  PLATFORM_ACTOR_ROLE,
  PLATFORM_ADMIN_ACTOR_ID,
  SYSTEM_ACTOR_ID,
  systemActorLabel,
} from "../member-change-text.js";
import {
  CommunitySystemMessageType,
  type CommunitySystemMessageType as CommunitySystemMessageTypeValue,
} from "./system-message.js";

/**
 * Every builder below takes an optional `locale` that DEFAULTS to
 * {@link STORED_TEXT_LOCALE} (English). Write paths leave it alone — the text
 * persisted on the row stays English forever, so historical rows never shift
 * language under a config change. Read paths (REST serializers, socket
 * fan-out, push) pass the VIEWER's locale, which is what actually localizes
 * the sentence a user sees.
 */

/**
 * Prefer first + last name (`displayName`); never fall back to username/handle
 * (system-message sentences read as "X added Y", a raw handle reads wrong
 * there). Still needs SOME non-empty label when displayName is unresolved
 * (snapshot-cache miss) — otherwise the persisted sentence renders with a
 * blank actor/target ("added "), permanently, since system message text is
 * baked in at send time and never recomputed.
 */
export function resolvePersonDisplayName(
  snapshot: Record<string, unknown> | null | undefined,
  locale: SupportedLocale = STORED_TEXT_LOCALE
): string {
  const name = snapshot ? String(snapshot.displayName ?? "").trim() : "";
  return name || t("SYS_NAME_UNKNOWN_USER", locale);
}

/**
 * Human-readable mute duration from whole minutes, rendered to match the client
 * duration picker labels (5m / 10m / 30m / 1h / 6h / 24h / 7d / 30d):
 *   5 → "5 minutes", 30 → "30 minutes", 60 → "1 hour", 360 → "6 hours",
 *   1440 → "24 hours", 10080 → "7 days", 43200 → "30 days".
 * Sub-7-day clean-hour spans stay in HOURS (so 1440 reads "24 hours", not
 * "1 day"); 7 days and up render in DAYS. Falls back to minutes for odd values.
 *
 * Plural selection is English-driven (`_ONE` / `_OTHER`); vi and th carry the
 * same string in both slots because neither marks plural on the noun.
 */
export function formatMuteDuration(
  minutes: number,
  locale: SupportedLocale = STORED_TEXT_LOCALE
): string {
  // 7 days (10080 min) and beyond → days, matching the 7d / 30d presets.
  if (minutes >= 10080 && minutes % 1440 === 0) {
    const days = minutes / 1440;
    return t(
      days === 1 ? "SYS_DURATION_DAY_ONE" : "SYS_DURATION_DAY_OTHER",
      locale,
      {
        count: days,
      }
    );
  }
  // 1h..< 7d in whole hours → hours, so 24h stays "24 hours".
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return t(
      hours === 1 ? "SYS_DURATION_HOUR_ONE" : "SYS_DURATION_HOUR_OTHER",
      locale,
      { count: hours }
    );
  }
  return t(
    minutes === 1 ? "SYS_DURATION_MINUTE_ONE" : "SYS_DURATION_MINUTE_OTHER",
    locale,
    { count: minutes }
  );
}

/** Livestream runtime: "1h 24m" / "24m" / "<1m" — see {@link formatDurationShort}. */
export function formatStreamDuration(
  totalSeconds: number,
  locale: SupportedLocale = STORED_TEXT_LOCALE
): string {
  return formatDurationShort(totalSeconds, locale);
}

/** "MODERATOR" → "moderator", "ADMIN" → "admin". */
function roleArticleForm(role: string, locale: SupportedLocale): string {
  const r = role.toUpperCase();
  if (r === "ADMIN") return t("SYS_ROLE_ADMIN_ARTICLE", locale);
  if (r === "MODERATOR") return t("SYS_ROLE_MODERATOR_ARTICLE", locale);
  return t("SYS_ROLE_MEMBER_ARTICLE", locale);
}

function actorUserIdOf(metadata: Record<string, unknown>): string {
  return String(metadata.actorUserId ?? metadata.actorId ?? "").trim();
}

function targetUserIdOf(metadata: Record<string, unknown>): string {
  return String(metadata.targetUserId ?? metadata.targetId ?? "").trim();
}

function visibilityOf(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

/**
 * Localized text per community SYSTEM subtype, from the VIEWER's point of view
 * (actor / affected person / everyone else). v2 rows carry an `actorRole`
 * snapshot and name the actor "Minh (Admin)"; rows without one render as before.
 */
export function buildCommunitySystemFallbackText(
  type: CommunitySystemMessageTypeValue,
  metadata: Record<string, unknown>,
  actorName: string,
  targetName: string,
  viewerUserId?: string | null,
  locale: SupportedLocale = STORED_TEXT_LOCALE,
  timeZone: string = currentTimeZone()
): string {
  // Platform staff (Backoffice `source: "BO"`, legacy platform id, or the v2
  // PLATFORM role) is "AI Mess Administrator" for every reader, never "You".
  const byBackoffice =
    metadata.source === BACKOFFICE_SOURCE ||
    actorUserIdOf(metadata) === PLATFORM_ADMIN_ACTOR_ID ||
    visibilityOf(metadata.actorRole) === PLATFORM_ACTOR_ROLE;
  const rawActorName = actorName || String(metadata.actorName ?? "");
  const named = byBackoffice
    ? administratorActorLabel(locale)
    : namedActorLabel(rawActorName, metadata.actorRole, locale);
  const v2 = named !== null;
  const plainActor = rawActorName || t("SYS_NAME_SOMEONE", locale);
  const actor = named ?? plainActor;
  const target =
    (metadata.targetName as string) ||
    targetName ||
    t("SYS_NAME_A_MEMBER_CAP", locale);
  const midTarget =
    (metadata.targetName as string) || targetName || t("SYS_NAME_A_MEMBER", locale);

  const actorId = actorUserIdOf(metadata);
  const targetId = targetUserIdOf(metadata);
  const viewer = viewerUserId?.trim() ?? "";
  const isActor = Boolean(
    !byBackoffice && viewer && actorId && viewer === actorId
  );
  const isTarget =
    type === "ROLE_CHANGED_SELF" ||
    Boolean(viewer && targetId && viewer === targetId);
  // Auto-unmute sweeper (`source: "auto"`, "system" actor) and legacy rows
  // without an actor stay passive ("X was unmuted").
  const namesActor =
    byBackoffice ||
    Boolean(actorId && actorId !== "system" && metadata.source !== "auto");
  const you = t("SYS_SENDER_YOU", locale);
  const youObject = t("SYS_NAME_YOU_OBJECT", locale);
  const entity = entityLabel(metadata.communityName as string, "COMMUNITY", locale);
  // Legacy shared member-change sentence (member-change-text.ts).
  const memberChangeLabels = () => ({
    actor: isActor
      ? you
      : actorId === SYSTEM_ACTOR_ID && !byBackoffice
        ? systemActorLabel(locale)
        : actor,
    target: isTarget ? youObject : midTarget,
    entity,
  });
  const v2Labels = () => ({
    actor: isActor ? you : actor,
    target: isTarget ? youObject : midTarget,
  });

  switch (type) {
    case "COMMUNITY_CREATED":
      return t("SYS_COMMUNITY_CREATED", locale);
    case "COMMUNITY_NAME_UPDATED": {
      const newName = ((metadata.newName as string) || "").trim();
      if (v2 && newName) {
        return isActor
          ? t("SYS_COMMUNITY_RENAMED_SELF", locale, { name: newName })
          : t("SYS_COMMUNITY_RENAMED_BY", locale, { actor, name: newName });
      }
      return newName
        ? t("SYS_COMMUNITY_RENAMED", locale, { name: newName })
        : t("SYS_COMMUNITY_NAME_UPDATED", locale);
    }
    case "COMMUNITY_AVATAR_UPDATED":
    case "COMMUNITY_BANNER_UPDATED":
      if (v2) {
        return isActor
          ? t("SYS_COMMUNITY_PHOTO_CHANGED_SELF", locale)
          : t("SYS_COMMUNITY_PHOTO_CHANGED_BY", locale, { actor });
      }
      return t(
        type === "COMMUNITY_AVATAR_UPDATED"
          ? "SYS_COMMUNITY_AVATAR_UPDATED"
          : "SYS_COMMUNITY_BANNER_UPDATED",
        locale
      );
    case "COMMUNITY_DESCRIPTION_UPDATED":
    case "COMMUNITY_HANDLE_UPDATED":
    case "COMMUNITY_UPDATED": {
      if (v2) {
        return isActor
          ? t("SYS_COMMUNITY_SETTINGS_UPDATED_SELF", locale)
          : t("SYS_COMMUNITY_SETTINGS_UPDATED_BY", locale, { actor });
      }
      if (type === "COMMUNITY_DESCRIPTION_UPDATED")
        return t("SYS_COMMUNITY_DESCRIPTION_UPDATED", locale);
      if (type === "COMMUNITY_HANDLE_UPDATED")
        return t("SYS_COMMUNITY_HANDLE_UPDATED", locale);
      // Legacy rows: a single known change keeps its specific sentence.
      const fields = Array.isArray(metadata.changedFields)
        ? (metadata.changedFields as unknown[])
        : [];
      if (fields.length === 1 && fields[0] === "category") {
        return t("SYS_COMMUNITY_CATEGORY_UPDATED", locale);
      }
      if (fields.length === 1 && fields[0] === "visibility") {
        const to = visibilityOf(metadata.newVisibility);
        if (to === "PRIVATE") return t("SYS_COMMUNITY_NOW_PRIVATE", locale);
        if (to === "PUBLIC") return t("SYS_COMMUNITY_NOW_PUBLIC", locale);
      }
      return t("SYS_COMMUNITY_UPDATED", locale);
    }
    case "COMMUNITY_PRIVACY_CHANGED": {
      const to = visibilityOf(metadata.newVisibility);
      if (to === "PRIVATE") {
        return isActor
          ? t("SYS_COMMUNITY_PRIVACY_PRIVATE_SELF", locale)
          : t("SYS_COMMUNITY_PRIVACY_PRIVATE", locale, { actor });
      }
      if (to === "PUBLIC") {
        return isActor
          ? t("SYS_COMMUNITY_PRIVACY_PUBLIC_SELF", locale)
          : t("SYS_COMMUNITY_PRIVACY_PUBLIC", locale, { actor });
      }
      return t("SYS_COMMUNITY_UPDATED", locale);
    }
    case "LIVE_STREAM_STARTED":
      // The host is named plainly: starting a stream is not a role action.
      return isActor
        ? t("SYS_COMMUNITY_LIVESTREAM_STARTED_SELF", locale)
        : t("SYS_COMMUNITY_LIVESTREAM_STARTED", locale, {
            actor: byBackoffice ? actor : plainActor,
          });
    case "LIVE_STREAM_ENDED": {
      // `durationSeconds` re-derives the label per reader; the baked `duration`
      // only covers rows written without it.
      const duration =
        typeof metadata.durationSeconds === "number"
          ? formatDurationShort(metadata.durationSeconds, locale)
          : ((metadata.duration as string) || "").trim();
      const reason = String(metadata.endedReason ?? "");
      // "ADMIN" = platform staff ended it (that row's actor IS the host).
      const endedHost = (
        (metadata.targetName as string) ||
        targetName ||
        (reason === "ADMIN" || reason === "CONNECTION_LOST" ? rawActorName : "") ||
        ""
      ).trim();
      const viewerIsHost = Boolean(
        viewer &&
          viewer === ((metadata.hostUserId as string) || targetId || actorId)
      );
      if (reason === "CONNECTION_LOST" && viewerIsHost) {
        return t("SYS_COMMUNITY_LIVESTREAM_LOST_SELF", locale);
      }
      const platform = administratorActorLabel(locale);
      const lead =
        reason === "CONNECTION_LOST"
          ? t("SYS_COMMUNITY_LIVESTREAM_LOST", locale, { host: endedHost || plainActor })
          : reason === "ADMIN"
            ? viewerIsHost
              ? t("SYS_COMMUNITY_LIVESTREAM_ENDED_YOURS", locale, { actor: platform })
              : endedHost
                ? t("SYS_COMMUNITY_LIVESTREAM_ENDED_BY_ADMIN_HOST", locale, { host: endedHost })
                : t("SYS_COMMUNITY_LIVESTREAM_ENDED_BY_ADMIN", locale)
            : reason === "SYSTEM"
              ? t("SYS_COMMUNITY_LIVESTREAM_ENDED_BY_SYSTEM", locale)
              : endedHost && targetId && targetId !== actorId
                ? isActor
                  ? t("SYS_COMMUNITY_LIVESTREAM_ENDED_HOST_SELF", locale, { host: endedHost })
                  : viewerIsHost
                    ? t("SYS_COMMUNITY_LIVESTREAM_ENDED_YOURS", locale, { actor })
                    : t("SYS_COMMUNITY_LIVESTREAM_ENDED_HOST", locale, { actor, host: endedHost })
                : isActor
                  ? t("SYS_COMMUNITY_LIVESTREAM_ENDED_SELF", locale)
                  : t("SYS_COMMUNITY_LIVESTREAM_ENDED", locale, { actor: plainActor });
      return duration
        ? t("SYS_COMMUNITY_LIVESTREAM_ENDED_DURATION", locale, { lead, duration })
        : lead;
    }

    case "ROLE_CHANGED":
    case "MEMBER_ROLE_CHANGED":
    case "ROLE_CHANGED_SELF": {
      const newRole = ((metadata.newRole as string) || "").toUpperCase();
      const oldRole = ((metadata.oldRole as string) || "").toUpperCase();
      const auto = metadata.auto === true;
      if (newRole === "ADMIN" && (auto || v2)) {
        if (auto || !namesActor) {
          if (isTarget) return t("SYS_COMMUNITY_NOW_ADMIN_SELF", locale, { entity });
          if (viewer && viewer === String(metadata.formerAdminUserId ?? ""))
            return t("SYS_COMMUNITY_NOW_MODERATOR_SELF", locale, { entity });
          return t("SYS_COMMUNITY_NOW_ADMIN", locale, { target });
        }
        if (isActor) return t("SYS_COMMUNITY_MADE_ADMIN_ACTOR", locale, { target: midTarget });
        if (isTarget) return t("SYS_COMMUNITY_MADE_ADMIN_TARGET", locale, { actor });
        return t("SYS_COMMUNITY_MADE_ADMIN", locale, { actor, target: midTarget });
      }
      if (v2 && newRole === "MODERATOR" && oldRole !== "ADMIN") {
        if (isActor) return t("SYS_COMMUNITY_MADE_MODERATOR_ACTOR", locale, { target: midTarget });
        if (isTarget) return t("SYS_COMMUNITY_MADE_MODERATOR_TARGET", locale, { actor });
        return t("SYS_COMMUNITY_MADE_MODERATOR", locale, { actor, target: midTarget });
      }
      if (v2 && newRole === "MEMBER" && oldRole === "MODERATOR") {
        if (isActor) return t("SYS_COMMUNITY_REMOVED_MODERATOR_ACTOR", locale, { target: midTarget });
        if (isTarget) return t("SYS_COMMUNITY_REMOVED_MODERATOR_TARGET", locale, { actor });
        return t("SYS_COMMUNITY_REMOVED_MODERATOR", locale, { actor, target: midTarget });
      }
      // Legacy rows (no actorRole): role-state wording.
      if (newRole === "ADMIN") {
        return isTarget
          ? t("SYS_COMMUNITY_ROLE_ADMIN_SELF", locale)
          : t("SYS_COMMUNITY_ROLE_ADMIN", locale, { target });
      }
      if (
        newRole === "MEMBER" &&
        (oldRole === "ADMIN" || oldRole === "MODERATOR")
      ) {
        return isTarget
          ? t("SYS_COMMUNITY_ROLE_MEMBER_SELF", locale)
          : t("SYS_COMMUNITY_ROLE_MEMBER", locale, { target });
      }
      const role = roleArticleForm(newRole, locale);
      return isTarget
        ? t("SYS_COMMUNITY_ROLE_CHANGED_SELF", locale, { role })
        : t("SYS_COMMUNITY_ROLE_CHANGED", locale, { target, role });
    }

    case "MEMBER_JOINED":
      if (isTarget || isActor)
        return t("SYS_COMMUNITY_MEMBER_JOINED_SELF", locale);
      return t("SYS_COMMUNITY_MEMBER_JOINED", locale, { target });

    case "MEMBER_LEFT":
      if (isTarget) return t("SYS_COMMUNITY_MEMBER_LEFT_SELF", locale);
      return t("SYS_COMMUNITY_MEMBER_LEFT", locale, { target });

    case "MEMBER_REMOVED":
      return v2
        ? t("SYS_COMMUNITY_MEMBER_REMOVED", locale, v2Labels())
        : memberChangeText("REMOVED", memberChangeLabels(), locale);

    // The target's own wording first, then the acting moderator's "You …",
    // then the other moderators' "{actor} … {target}" (passive when no person acted).
    case "MEMBER_BANNED":
      if (isTarget) return t("SYS_COMMUNITY_MEMBER_BANNED_SELF", locale);
      if (isActor)
        return t("SYS_COMMUNITY_MEMBER_BANNED_ACTOR", locale, { target });
      if (namesActor)
        return t("SYS_COMMUNITY_MEMBER_BANNED_BY", locale, { actor, target });
      return t("SYS_COMMUNITY_MEMBER_BANNED", locale, { target });

    case "MEMBER_UNBANNED":
      if (isTarget) return t("SYS_COMMUNITY_MEMBER_UNBANNED_SELF", locale);
      if (isActor)
        return t("SYS_COMMUNITY_MEMBER_UNBANNED_ACTOR", locale, { target });
      if (namesActor)
        return t("SYS_COMMUNITY_MEMBER_UNBANNED_BY", locale, { actor, target });
      return t("SYS_COMMUNITY_MEMBER_UNBANNED", locale, { target });

    case "MEMBER_MUTED": {
      const mutedUntilMs = Number(metadata.mutedUntil);
      const until =
        Number.isFinite(mutedUntilMs) && mutedUntilMs > 0
          ? formatViewerDateTime(mutedUntilMs, locale, timeZone)
          : null;
      if (isTarget) {
        if (v2 && namesActor) {
          return until
            ? t("SYS_COMMUNITY_MEMBER_MUTED_UNTIL_TARGET", locale, { actor, until })
            : t("SYS_COMMUNITY_MEMBER_MUTED_TARGET", locale, { actor });
        }
        return until
          ? t("SYS_COMMUNITY_MEMBER_MUTED_UNTIL_SELF", locale, { until })
          : t("SYS_COMMUNITY_MEMBER_MUTED_SELF", locale);
      }
      if (until) {
        if (isActor)
          return t("SYS_COMMUNITY_MEMBER_MUTED_UNTIL_ACTOR", locale, { target, until });
        if (namesActor)
          return t("SYS_COMMUNITY_MEMBER_MUTED_UNTIL_BY", locale, { actor, target, until });
        return t("SYS_COMMUNITY_MEMBER_MUTED_UNTIL", locale, { target, until });
      }
      if (isActor)
        return t("SYS_COMMUNITY_MEMBER_MUTED_ACTOR", locale, { target });
      if (namesActor)
        return t("SYS_COMMUNITY_MEMBER_MUTED_BY", locale, { actor, target });
      return t("SYS_COMMUNITY_MEMBER_MUTED", locale, { target });
    }

    case "MEMBER_UNMUTED":
      // Manual unmute and auto-expiry read the same for the affected member.
      if (isTarget) return t("SYS_COMMUNITY_CAN_CHAT_AGAIN", locale, { entity });
      if (isActor)
        return t("SYS_COMMUNITY_MEMBER_UNMUTED_ACTOR", locale, { target });
      if (namesActor)
        return t("SYS_COMMUNITY_MEMBER_UNMUTED_BY", locale, { actor, target });
      return t("SYS_COMMUNITY_MEMBER_UNMUTED", locale, { target });

    case "PINNED_MESSAGE":
      if (isActor) return t("SYS_COMMUNITY_MESSAGE_PINNED_SELF", locale);
      return t("SYS_COMMUNITY_MESSAGE_PINNED", locale, { actor });

    case "UNPINNED_MESSAGE":
      if (isActor) return t("SYS_COMMUNITY_MESSAGE_UNPINNED_SELF", locale);
      return t("SYS_COMMUNITY_MESSAGE_UNPINNED", locale, { actor });

    case "COMMUNITY_INVITE_CREATED":
      if (isActor) return t("SYS_COMMUNITY_INVITE_CREATED_SELF", locale);
      return t("SYS_COMMUNITY_INVITE_CREATED", locale, { actor });

    case "MESSAGE_DELETED": {
      const senderId = String(metadata.senderId ?? "").trim();
      if (isActor) return t("SYS_MESSAGE_DELETED_ACTOR", locale);
      if (viewer && senderId && viewer === senderId)
        return t("SYS_MESSAGE_DELETED_SENDER", locale, { actor });
      return t("SYS_MESSAGE_DELETED", locale, { actor });
    }

    case "COMMUNITY_CLOSED":
      if (isActor) return t("SYS_COMMUNITY_CLOSED_SELF", locale);
      return t("SYS_COMMUNITY_CLOSED", locale, { actor });

    case "COMMUNITY_REOPENED":
      if (isActor) return t("SYS_COMMUNITY_REOPENED_SELF", locale);
      return t("SYS_COMMUNITY_REOPENED", locale, { actor });

    // JOIN_REQUEST_APPROVED is retired; legacy rows render as COMMUNITY_JOINED.
    case "COMMUNITY_JOINED":
    case "JOIN_REQUEST_APPROVED":
      return t("SYS_COMMUNITY_MEMBER_JOINED_SELF", locale);
    case "MEMBER_ADDED": {
      // Batch add (one operation ⇒ one audit line) lists every target, like groups.
      if (v2) {
        const grouped = groupedTargetLabels(metadata, viewer, locale, youObject);
        const labels = v2Labels();
        return t("SYS_MEMBER_ADDED", locale, {
          ...labels,
          target: grouped ? formatNameList(grouped, locale) : labels.target,
        });
      }
      const grouped = groupedTargetLabels(metadata, viewer, locale, youObject);
      const labels = memberChangeLabels();
      return memberChangeText(
        "ADDED",
        grouped ? { ...labels, target: formatNameList(grouped, locale) } : labels,
        locale
      );
    }
    case "JOIN_REQUEST_REJECTED":
      return t("SYS_COMMUNITY_JOIN_REQUEST_REJECTED", locale);

    default:
      return t("SYS_COMMUNITY_UPDATED", locale);
  }
}

/**
 * Member whose community-list / socket preview should read "You …" for a
 * COMMUNITY-visible system line. Returns null when everyone sees the same text.
 */
export function resolveCommunitySystemSubjectUserId(
  type: CommunitySystemMessageTypeValue,
  metadata: Record<string, unknown>,
  triggeredByUserId: string
): string | null {
  const targetId = targetUserIdOf(metadata);
  const actorId = actorUserIdOf(metadata) || triggeredByUserId;

  switch (type) {
    case "ROLE_CHANGED":
    case "MEMBER_ROLE_CHANGED":
    case "MEMBER_REMOVED":
    case "MEMBER_BANNED":
    case "MEMBER_UNBANNED":
    case "MEMBER_MUTED":
    case "MEMBER_UNMUTED":
    case "MEMBER_LEFT":
      return targetId || null;
    case "PINNED_MESSAGE":
    case "UNPINNED_MESSAGE":
    case "COMMUNITY_INVITE_CREATED":
    case "COMMUNITY_PRIVACY_CHANGED":
      return actorId || null;
    case "MESSAGE_DELETED":
      return String(metadata.senderId ?? "").trim() || null;
    default:
      return null;
  }
}

/** First-person preview for the subject member (community list + live bump). */
export function buildCommunitySystemSelfPreview(
  type: CommunitySystemMessageTypeValue,
  metadata: Record<string, unknown>,
  actorName: string,
  targetName: string,
  subjectUserId: string,
  locale: SupportedLocale = STORED_TEXT_LOCALE,
  timeZone: string = currentTimeZone()
): string {
  if (type === "MEMBER_JOINED") {
    return buildCommunitySystemFallbackText(
      "COMMUNITY_JOINED",
      metadata,
      "",
      "",
      subjectUserId,
      locale
    );
  }
  return buildCommunitySystemFallbackText(
    type,
    metadata,
    actorName,
    targetName,
    subjectUserId,
    locale,
    timeZone
  );
}

/**
 * Render a persisted community SYSTEM line for ONE viewer, in THAT viewer's
 * language. `thirdPersonText` is the English sentence baked onto the row; it is
 * returned untouched only when the rebuild produces the same string (no viewer
 * personalization AND the viewer reads English).
 */
export function personalizeCommunitySystemMessageForViewer(
  type: CommunitySystemMessageTypeValue,
  metadata: Record<string, unknown>,
  thirdPersonText: string,
  actorName: string,
  targetName: string,
  viewerUserId: string,
  locale: SupportedLocale = STORED_TEXT_LOCALE,
  timeZone: string = currentTimeZone()
): string {
  if (!viewerUserId.trim() && locale === STORED_TEXT_LOCALE) {
    return thirdPersonText;
  }
  const personalized = buildCommunitySystemFallbackText(
    type,
    metadata,
    actorName,
    targetName,
    viewerUserId,
    locale,
    timeZone
  );
  return personalized === thirdPersonText ? thirdPersonText : personalized;
}

/**
 * Telegram-style copy for a community message reaction, in all three viewer
 * perspectives at once (community-service's `selectListPreview` picks the
 * right one per viewer; this is the single source of truth for the wording,
 * mirroring the SYSTEM-message self/third-person split above).
 *
 * Self-reaction (`isSelfReaction`, actor reacted to their own message) collapses
 * the target-perspective copy into the self copy since actor === target — there
 * is no third "you received a reaction" viewer in that case.
 */
export function buildReactionActivityText(params: {
  actorName: string;
  /**
   * The reacted-to message's own preview text (e.g. `"Let's meet at 5..."`
   * or `📷 Photo`), from `MessagePreviewService.buildReactionTargetPreview`.
   * Replaces the message owner's name so the line references WHAT was
   * reacted to, not WHO owns it (Telegram/WhatsApp convention).
   */
  targetMessagePreview: string;
  emoji: string;
  isSelfReaction: boolean;
  locale?: SupportedLocale;
}): {
  /** Shown to everyone except the actor and the target. */
  thirdPersonPreview: string;
  /** Shown to the actor (the person who reacted). */
  selfPreview: string;
  /** Shown to the target (the message owner), when target !== actor. */
  targetPreview: string;
} {
  const { actorName, targetMessagePreview, emoji, isSelfReaction } = params;
  const locale = params.locale ?? STORED_TEXT_LOCALE;
  const thirdPersonPreview = t("SYS_REACTION_THIRD_PERSON", locale, {
    actor: actorName,
    emoji,
    preview: targetMessagePreview,
  });
  const selfPreview = t("SYS_REACTION_SELF", locale, {
    emoji,
    preview: targetMessagePreview,
  });
  if (isSelfReaction) {
    return { thirdPersonPreview, selfPreview, targetPreview: selfPreview };
  }
  return {
    thirdPersonPreview,
    selfPreview,
    // Target (message owner) sees WHAT was reacted to, same as everyone else —
    // not a vague "your message" placeholder.
    targetPreview: thirdPersonPreview,
  };
}

/** Structured reaction overlay sent beside the localized `lastActivity.preview`. */
export interface ReactionActivityInfo {
  emoji: string;
  actorId: string;
  targetMessageId: string;
}

const SENTINEL_ACTOR = "\u0000A\u0000";
const SENTINEL_PREVIEW = "\u0000P\u0000";

/**
 * Re-renders a reaction activity line that {@link buildReactionActivityText}
 * stored in STORED_TEXT_LOCALE, in the reader's [locale]. The actor and the
 * quoted target are recovered with the same stored-locale template, so no
 * schema field is needed; a line that matches neither template is returned
 * as stored.
 */
export function localizeReactionActivityText(
  stored: string,
  emoji: string,
  locale: SupportedLocale
): string {
  if (!stored || !emoji || locale === STORED_TEXT_LOCALE) return stored;
  const self = t("SYS_REACTION_SELF", STORED_TEXT_LOCALE, {
    emoji,
    preview: SENTINEL_PREVIEW,
  });
  const selfPrefix = self.slice(0, self.indexOf(SENTINEL_PREVIEW));
  if (self.endsWith(SENTINEL_PREVIEW) && stored.startsWith(selfPrefix)) {
    return t("SYS_REACTION_SELF", locale, {
      emoji,
      preview: stored.slice(selfPrefix.length),
    });
  }
  const third = t("SYS_REACTION_THIRD_PERSON", STORED_TEXT_LOCALE, {
    actor: SENTINEL_ACTOR,
    emoji,
    preview: SENTINEL_PREVIEW,
  });
  const middle = third.slice(
    third.indexOf(SENTINEL_ACTOR) + SENTINEL_ACTOR.length,
    third.indexOf(SENTINEL_PREVIEW)
  );
  const at = stored.indexOf(middle);
  if (!third.startsWith(SENTINEL_ACTOR) || !third.endsWith(SENTINEL_PREVIEW) || at <= 0) {
    return stored;
  }
  return t("SYS_REACTION_THIRD_PERSON", locale, {
    actor: stored.slice(0, at),
    emoji,
    preview: stored.slice(at + middle.length),
  });
}

export { CommunitySystemMessageType };
