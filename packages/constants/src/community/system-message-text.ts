import { t } from "../i18n.js";
import { STORED_TEXT_LOCALE, type SupportedLocale } from "../locale.js";
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

/**
 * Human-readable livestream runtime from whole seconds, Telegram-style:
 *   5040 → "1h 24m", 3600 → "1h", 1440 → "24m", 45 → "45s", 0 → "0s".
 * Hours+minutes when ≥ 1h (minutes dropped on the exact hour), minutes when
 * ≥ 1m, otherwise seconds. Used for the LIVE_STREAM_ENDED system message and
 * the livestream-ended push body.
 */
export function formatStreamDuration(
  totalSeconds: number,
  locale: SupportedLocale = STORED_TEXT_LOCALE
): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (hours > 0) {
    return minutes > 0
      ? t("SYS_STREAM_DURATION_HM", locale, { hours, minutes })
      : t("SYS_STREAM_DURATION_H", locale, { hours });
  }
  if (minutes > 0) return t("SYS_STREAM_DURATION_M", locale, { minutes });
  return t("SYS_STREAM_DURATION_S", locale, { seconds: s });
}

const INTL_LOCALE: Record<SupportedLocale, string> = {
  en: "en-US",
  vi: "vi-VN",
  th: "th-TH",
};

/**
 * Absolute mute-expiry timestamp inside a system line.
 *
 * English keeps `toUTCString()` verbatim: that exact string is what gets BAKED
 * into the stored row, and rewriting it would silently change every historical
 * MEMBER_MUTED sentence. Other locales format through `Intl` (still UTC) since
 * an RFC-1123 English date inside a Thai sentence reads as untranslated.
 */
function formatSystemDateTime(ms: number, locale: SupportedLocale): string {
  const at = new Date(ms);
  if (locale === "en") return at.toUTCString();
  return `${new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(at)} UTC`;
}

/** "MODERATOR" → "moderator", "ADMIN" → "admin". */
function roleArticleForm(role: string, locale: SupportedLocale): string {
  const r = role.toUpperCase();
  if (r === "ADMIN") return t("SYS_ROLE_ADMIN_ARTICLE", locale);
  if (r === "MODERATOR") return t("SYS_ROLE_MODERATOR_ARTICLE", locale);
  return t("SYS_ROLE_MEMBER_ARTICLE", locale);
}

function actorUserIdOf(metadata: Record<string, unknown>): string {
  return String(metadata.actorUserId ?? "").trim();
}

function targetUserIdOf(metadata: Record<string, unknown>): string {
  return String(metadata.targetUserId ?? "").trim();
}

/**
 * Localized text per community SYSTEM subtype (Telegram phrasing). When
 * `viewerUserId` is set and matches the actor or subject, names are replaced
 * with first-person "You …" forms for that viewer.
 */
export function buildCommunitySystemFallbackText(
  type: CommunitySystemMessageTypeValue,
  metadata: Record<string, unknown>,
  actorName: string,
  targetName: string,
  viewerUserId?: string | null,
  locale: SupportedLocale = STORED_TEXT_LOCALE
): string {
  const actor = actorName || t("SYS_NAME_SOMEONE", locale);
  const target =
    (metadata.targetName as string) ||
    targetName ||
    t("SYS_NAME_A_MEMBER_CAP", locale);

  const actorId = actorUserIdOf(metadata);
  const targetId = targetUserIdOf(metadata);
  const viewer = viewerUserId?.trim() ?? "";
  const isActor = Boolean(viewer && actorId && viewer === actorId);
  const isTarget = Boolean(viewer && targetId && viewer === targetId);

  switch (type) {
    case "COMMUNITY_CREATED":
      return t("SYS_COMMUNITY_CREATED", locale);
    case "COMMUNITY_NAME_UPDATED": {
      const newName = ((metadata.newName as string) || "").trim();
      return newName
        ? t("SYS_COMMUNITY_RENAMED", locale, { name: newName })
        : t("SYS_COMMUNITY_NAME_UPDATED", locale);
    }
    case "COMMUNITY_DESCRIPTION_UPDATED":
      return t("SYS_COMMUNITY_DESCRIPTION_UPDATED", locale);
    case "COMMUNITY_AVATAR_UPDATED":
      return t("SYS_COMMUNITY_AVATAR_UPDATED", locale);
    case "COMMUNITY_BANNER_UPDATED":
      return t("SYS_COMMUNITY_BANNER_UPDATED", locale);
    case "COMMUNITY_HANDLE_UPDATED":
      return t("SYS_COMMUNITY_HANDLE_UPDATED", locale);
    case "COMMUNITY_UPDATED":
      return t("SYS_COMMUNITY_UPDATED", locale);
    case "LIVE_STREAM_STARTED":
      // Host-named (Telegram group video-chat parity). "You started …" for the
      // host's own view; "{host} started …" for everyone else.
      return isActor
        ? t("SYS_COMMUNITY_LIVESTREAM_STARTED_SELF", locale)
        : t("SYS_COMMUNITY_LIVESTREAM_STARTED", locale, { actor });
    case "LIVE_STREAM_ENDED": {
      // Stored fallback stays single-line so the community-list preview is clean;
      // the client composes the richer two-line "…ended the livestream / Duration:
      // {duration}" from systemMessageType + systemMetadata.duration.
      const duration = ((metadata.duration as string) || "").trim();
      const lead = isActor
        ? t("SYS_COMMUNITY_LIVESTREAM_ENDED_SELF", locale)
        : t("SYS_COMMUNITY_LIVESTREAM_ENDED", locale, { actor });
      return duration
        ? t("SYS_COMMUNITY_LIVESTREAM_ENDED_DURATION", locale, {
            lead,
            duration,
          })
        : lead;
    }

    case "ROLE_CHANGED":
    case "MEMBER_ROLE_CHANGED": {
      if (isTarget) {
        return buildCommunitySystemFallbackText(
          "ROLE_CHANGED_SELF",
          metadata,
          "",
          "",
          viewer,
          locale
        );
      }
      const newRole = ((metadata.newRole as string) || "").toUpperCase();
      const oldRole = ((metadata.oldRole as string) || "").toUpperCase();
      // Admin promotion is an ownership hand-off — there is exactly ONE admin, so
      // phrase it as "the community admin" (Telegram-style) rather than "an admin".
      if (newRole === "ADMIN") {
        return t("SYS_COMMUNITY_ROLE_ADMIN", locale, { target });
      }
      if (
        newRole === "MEMBER" &&
        (oldRole === "ADMIN" || oldRole === "MODERATOR")
      ) {
        return t("SYS_COMMUNITY_ROLE_MEMBER", locale, { target });
      }
      return t("SYS_COMMUNITY_ROLE_CHANGED", locale, {
        target,
        role: roleArticleForm(newRole, locale),
      });
    }

    case "ROLE_CHANGED_SELF": {
      const newRole = ((metadata.newRole as string) || "").toUpperCase();
      const oldRole = ((metadata.oldRole as string) || "").toUpperCase();
      if (newRole === "ADMIN") {
        return t("SYS_COMMUNITY_ROLE_ADMIN_SELF", locale);
      }
      if (
        newRole === "MEMBER" &&
        (oldRole === "ADMIN" || oldRole === "MODERATOR")
      ) {
        return t("SYS_COMMUNITY_ROLE_MEMBER_SELF", locale);
      }
      return t("SYS_COMMUNITY_ROLE_CHANGED_SELF", locale, {
        role: roleArticleForm(newRole, locale),
      });
    }

    case "MEMBER_JOINED":
      if (isTarget || isActor)
        return t("SYS_COMMUNITY_MEMBER_JOINED_SELF", locale);
      return t("SYS_COMMUNITY_MEMBER_JOINED", locale, { target });

    case "MEMBER_LEFT":
      if (isTarget) return t("SYS_COMMUNITY_MEMBER_LEFT_SELF", locale);
      return t("SYS_COMMUNITY_MEMBER_LEFT", locale, { target });

    case "MEMBER_REMOVED":
      if (isTarget) return t("SYS_COMMUNITY_MEMBER_REMOVED_SELF", locale);
      return t("SYS_COMMUNITY_MEMBER_REMOVED", locale, { target });

    case "MEMBER_BANNED":
      // PERSONAL message — only the banned member ever reads this.
      if (isTarget) return t("SYS_COMMUNITY_MEMBER_BANNED_SELF", locale);
      return t("SYS_COMMUNITY_MEMBER_BANNED", locale, { target });

    case "MEMBER_UNBANNED":
      if (isTarget) return t("SYS_COMMUNITY_MEMBER_UNBANNED_SELF", locale);
      return t("SYS_COMMUNITY_MEMBER_UNBANNED", locale, { target });

    case "MEMBER_MUTED": {
      // PERSONAL message — only the muted member ever reads this.
      // Show the concrete expiry timestamp so the user knows exactly when they
      // can post again; fall back to "indefinitely" when no expiry was set.
      const mutedUntilMs = Number(metadata.mutedUntil);
      if (Number.isFinite(mutedUntilMs) && mutedUntilMs > 0) {
        const until = formatSystemDateTime(mutedUntilMs, locale);
        if (isTarget)
          return t("SYS_COMMUNITY_MEMBER_MUTED_UNTIL_SELF", locale, { until });
        return t("SYS_COMMUNITY_MEMBER_MUTED_UNTIL", locale, { target, until });
      }
      if (isTarget) return t("SYS_COMMUNITY_MEMBER_MUTED_SELF", locale);
      return t("SYS_COMMUNITY_MEMBER_MUTED", locale, { target });
    }

    case "MEMBER_UNMUTED":
      if (isTarget) return t("SYS_COMMUNITY_MEMBER_UNMUTED_SELF", locale);
      return t("SYS_COMMUNITY_MEMBER_UNMUTED", locale, { target });

    // The ACTOR is a person, never the community — a pin is performed by an
    // admin/moderator, so the line reads "{actor} pinned a message". Symmetrical
    // with UNPINNED_MESSAGE below. `actor` is the pinner's displayName, resolved
    // upstream from the user snapshot (see resolvePersonDisplayName).
    // metadata.communityName is still carried for clients that render the
    // community context alongside the line, but it is NOT the actor.
    case "PINNED_MESSAGE":
      if (isActor) return t("SYS_COMMUNITY_MESSAGE_PINNED_SELF", locale);
      return t("SYS_COMMUNITY_MESSAGE_PINNED", locale, { actor });

    case "UNPINNED_MESSAGE":
      if (isActor) return t("SYS_COMMUNITY_MESSAGE_UNPINNED_SELF", locale);
      return t("SYS_COMMUNITY_MESSAGE_UNPINNED", locale, { actor });

    case "COMMUNITY_INVITE_CREATED":
      if (isActor) return t("SYS_COMMUNITY_INVITE_CREATED_SELF", locale);
      return t("SYS_COMMUNITY_INVITE_CREATED", locale, { actor });

    case "COMMUNITY_JOINED":
      return t("SYS_COMMUNITY_MEMBER_JOINED_SELF", locale);
    // PERSONAL — only the added member reads it, so it is always second-person.
    // Names the admin who added them; `actor` falls back to "Someone" when the
    // snapshot is unresolved, same as every other actor-bearing line here.
    case "MEMBER_ADDED":
      return t("SYS_COMMUNITY_MEMBER_ADDED_SELF", locale, { actor });
    case "JOIN_REQUEST_APPROVED":
      return t("SYS_COMMUNITY_JOIN_REQUEST_APPROVED", locale);
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
      return actorId || null;
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
  locale: SupportedLocale = STORED_TEXT_LOCALE
): string {
  if (type === "ROLE_CHANGED" || type === "MEMBER_ROLE_CHANGED") {
    return buildCommunitySystemFallbackText(
      "ROLE_CHANGED_SELF",
      metadata,
      "",
      "",
      subjectUserId,
      locale
    );
  }
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
    locale
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
  locale: SupportedLocale = STORED_TEXT_LOCALE
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
    locale
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

export { CommunitySystemMessageType };
