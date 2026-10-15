import { resolvePersonDisplayName } from "../community/system-message-text.js";
import { t } from "../i18n.js";
import { STORED_TEXT_LOCALE, type SupportedLocale } from "../locale.js";
import {
  administratorActorLabel,
  BACKOFFICE_SOURCE,
  formatNameList,
  groupedTargetLabels,
  SYSTEM_ACTOR_ID,
  systemActorLabel,
} from "../member-change-text.js";

export { resolvePersonDisplayName };

export const ChatSystemMessageType = {
  GROUP_CREATED: "GROUP_CREATED",
  MEMBER_JOINED: "MEMBER_JOINED",
  MEMBER_LEFT: "MEMBER_LEFT",
  MEMBER_REMOVED: "MEMBER_REMOVED",
  MEMBER_ADDED: "MEMBER_ADDED",
  MEMBER_BANNED: "MEMBER_BANNED",
  MEMBER_UNBANNED: "MEMBER_UNBANNED",
  ROOM_RENAMED: "ROOM_RENAMED",
  ROLE_CHANGED: "ROLE_CHANGED",
  AVATAR_CHANGED: "AVATAR_CHANGED",
  ADMIN_ASSIGNED: "ADMIN_ASSIGNED",
  ADMIN_REMOVED: "ADMIN_REMOVED",
  OWNERSHIP_TRANSFERRED: "OWNERSHIP_TRANSFERRED",
  DESCRIPTION_CHANGED: "DESCRIPTION_CHANGED",
  INVITE_LINK_CREATED: "INVITE_LINK_CREATED",
  GROUP_INVITE: "GROUP_INVITE",
  CALL_STARTED: "CALL_STARTED",
  CALL_ENDED: "CALL_ENDED",
  MESSAGE_PINNED: "MESSAGE_PINNED",
  MESSAGE_UNPINNED: "MESSAGE_UNPINNED",
  MESSAGES_ENCRYPTED: "MESSAGES_ENCRYPTED",
  FRIENDSHIP_CREATED: "FRIENDSHIP_CREATED",
  FRIENDSHIP_DELETED: "FRIENDSHIP_DELETED",
  FRIENDSHIP_BLOCKED: "FRIENDSHIP_BLOCKED",
  FRIENDSHIP_BANNED: "FRIENDSHIP_BANNED",
  AUTO_DELETE_UPDATED: "AUTO_DELETE_UPDATED",
  /** Caller cleared / deleted their own copy of the history. Visible to that caller only. */
  CONVERSATION_CLEARED: "CONVERSATION_CLEARED",
  CONVERSATION_DELETED: "CONVERSATION_DELETED",
  /** Leader handover. data: actorId, actorName, targetUserId, targetName;
   *  automatic succession: auto: true, actorId null. */
  LEADER_CHANGED: "LEADER_CHANGED",
  /** Leader deleted another member's message. data: actorId, actorName,
   *  senderId, senderName, messageId. */
  MESSAGE_DELETED: "MESSAGE_DELETED",
} as const;

export type ChatSystemMessageType =
  (typeof ChatSystemMessageType)[keyof typeof ChatSystemMessageType];

/**
 * Shared Private/Group SYSTEM last-activity policy. Mirrors Community's
 * SYSTEM_MESSAGE_BUMPS_ACTIVITY: lifecycle churn and low-signal state changes
 * render in history without reordering the conversation list.
 */
export const CHAT_SYSTEM_MESSAGE_BUMPS_ACTIVITY: Record<
  ChatSystemMessageType,
  boolean
> = {
  GROUP_CREATED: true,
  MEMBER_JOINED: false,
  MEMBER_LEFT: false,
  MEMBER_REMOVED: false,
  MEMBER_ADDED: true,
  MEMBER_BANNED: false,
  MEMBER_UNBANNED: false,
  OWNERSHIP_TRANSFERRED: true,
  ROOM_RENAMED: true,
  ROLE_CHANGED: true,
  AVATAR_CHANGED: true,
  ADMIN_ASSIGNED: true,
  ADMIN_REMOVED: true,
  DESCRIPTION_CHANGED: true,
  INVITE_LINK_CREATED: false,
  GROUP_INVITE: true,
  CALL_STARTED: true,
  CALL_ENDED: true,
  MESSAGE_PINNED: true,
  MESSAGE_UNPINNED: false,
  MESSAGES_ENCRYPTED: false,
  FRIENDSHIP_CREATED: true,
  FRIENDSHIP_DELETED: true,
  FRIENDSHIP_BLOCKED: true,
  FRIENDSHIP_BANNED: false,
  // A privacy setting change is chat-relevant enough to reorder the inbox — it
  // tells the other side their next message will disappear.
  AUTO_DELETE_UPDATED: true,
  // Personal line on a history the caller just emptied: it must not become the
  // row's preview (for everyone else it does not exist; for the caller the
  // emptied row keeps reading as empty).
  CONVERSATION_CLEARED: false,
  CONVERSATION_DELETED: false,
  LEADER_CHANGED: true,
  MESSAGE_DELETED: false,
};

/**
 * The self-only clear/delete lines. Only the caller can ever read the row (it is
 * hidden for everyone else at write time), so there is no third-person form.
 */
function conversationHistoryText(
  event: string,
  locale: SupportedLocale
): string | null {
  if (event === "CONVERSATION_CLEARED")
    return t("SYS_CONVERSATION_CLEARED_SELF", locale);
  if (event === "CONVERSATION_DELETED")
    return t("SYS_CONVERSATION_DELETED_SELF", locale);
  return null;
}

export function chatSystemMessageBumpsActivity(event: string): boolean {
  return (
    CHAT_SYSTEM_MESSAGE_BUMPS_ACTIVITY[event as ChatSystemMessageType] ?? true
  );
}

/**
 * Auto-delete timer presets, spelled EXACTLY as the client picker spells them
 * (WhatsApp's wording) — note 86400 reads "24 hours", not "1 day", because that
 * is the menu entry the system message quotes back.
 */
const TTL_PRESET_UNITS: Record<number, [number, "HOUR" | "DAY"]> = {
  86400: [24, "HOUR"],
  604800: [7, "DAY"],
  7776000: [90, "DAY"],
};

/**
 * Localized label for a TTL in seconds ("24 hours" / "7 ngày" / "90 วัน").
 * Shared by the auto-delete wire block and the AUTO_DELETE_UPDATED system line
 * so both spell the same duration the same way in every language.
 */
export function formatTtlDuration(
  seconds: number | null,
  locale: SupportedLocale = STORED_TEXT_LOCALE
): string {
  const s = Number(seconds ?? 0);
  if (!s || s <= 0) return "";

  const unit = (count: number, u: "HOUR" | "DAY" | "MINUTE"): string =>
    t(
      count === 1
        ? (`SYS_DURATION_${u}_ONE` as const)
        : (`SYS_DURATION_${u}_OTHER` as const),
      locale,
      { count }
    );

  const preset = TTL_PRESET_UNITS[s];
  if (preset) return unit(preset[0], preset[1]);
  if (s % 86400 === 0) return unit(s / 86400, "DAY");
  if (s % 3600 === 0) return unit(s / 3600, "HOUR");
  if (s % 60 === 0) return unit(s / 60, "MINUTE");
  // Sub-minute custom timers are a raw count, not copy.
  return `${s}s`;
}

/**
 * "You set messages to delete after 7 days" — the AUTO_DELETE_UPDATED line.
 *
 * Shared verbatim by the private and group renderers: the wording never names a
 * peer or a group, so one spelling covers both surfaces and the two can't drift
 * into describing the same setting differently.
 */
function autoDeleteSystemText(
  data: Record<string, unknown>,
  who: string,
  locale: SupportedLocale
): string {
  const mode = String(data.mode ?? "OFF").toUpperCase();
  if (mode === "OFF") return t("SYS_PRIVATE_AUTO_DELETE_OFF", locale, { who });
  if (mode === "AFTER_VIEWING")
    return t("SYS_PRIVATE_AUTO_DELETE_AFTER_VIEWING", locale, { who });
  // Recompute from the stored `ttlSeconds` so the duration is in the READER's
  // language; `durationLabel` is the English label baked in at write time and is
  // only a fallback for rows written before ttlSeconds was persisted.
  const ttl = Number(data.ttlSeconds);
  const label =
    Number.isFinite(ttl) && ttl > 0
      ? formatTtlDuration(ttl, locale)
      : String(data.durationLabel ?? "").trim();
  return label
    ? t("SYS_PRIVATE_AUTO_DELETE_DURATION", locale, { who, duration: label })
    : t("SYS_PRIVATE_AUTO_DELETE_ON", locale, { who });
}

function groupRoleArticleForm(role: string, locale: SupportedLocale): string {
  const r = role.toUpperCase();
  if (r === "ADMIN") return t("SYS_ROLE_ADMIN_ARTICLE", locale);
  if (r === "MODERATOR") return t("SYS_ROLE_MODERATOR_ARTICLE", locale);
  return t("SYS_ROLE_MEMBER_ARTICLE", locale);
}

/** Events a Super Admin can post into a group from Backoffice. */
const BACKOFFICE_GROUP_EVENTS = new Set([
  "MEMBER_REMOVED",
  "MEMBER_BANNED",
  "MEMBER_UNBANNED",
  // Admin panel edits of the group's name / photo / description.
  "ROOM_RENAMED",
  "AVATAR_CHANGED",
  "DESCRIPTION_CHANGED",
]);

/**
 * True when a group SYSTEM line was posted by a Super Admin from Backoffice.
 * New rows carry `source: "BO"`. Legacy rows are recognised by shape: those
 * three events were only ever posted actor-less (`actorId: null`) by the
 * platform-admin path — every in-group removal/ban names its member actor.
 */
export function isBackofficeGroupSystemLine(
  event: string,
  data: Record<string, unknown>
): boolean {
  if (!BACKOFFICE_GROUP_EVENTS.has(event)) return false;
  return (
    data.source === BACKOFFICE_SOURCE || !String(data.actorId ?? "").trim()
  );
}

/**
 * The stored/wire `systemData` of a Backoffice line minus the acting admin's
 * name. Legacy rows baked the admin's real name into `actorName`; readers render
 * "Administrator" from the line's shape, so the name has no reader left.
 */
export function scrubBackofficeGroupSystemData(
  event: string,
  data: Record<string, unknown>
): Record<string, unknown> {
  if (!isBackofficeGroupSystemLine(event, data) || !("actorName" in data)) {
    return data;
  }
  const { actorName: _admin, ...rest } = data;
  return rest;
}

/**
 * Localized text per group SYSTEM event. When `viewerUserId` matches the actor
 * or subject, names are replaced with first-person "You …" forms.
 *
 * `locale` defaults to {@link STORED_TEXT_LOCALE} so the write path keeps
 * baking English onto the row; read paths pass the viewer's locale.
 */
export function buildGroupSystemFallbackText(
  event: string,
  data: Record<string, unknown>,
  viewerUserId?: string | null,
  locale: SupportedLocale = STORED_TEXT_LOCALE
): string {
  const historyLine = conversationHistoryText(event, locale);
  if (historyLine) return historyLine;
  // Same legacy invite aliasing as buildPrivateSystemFallbackText below.
  // Groups always name people plainly (no role label).
  const actor =
    (data.actorName as string) ||
    (data.inviterName as string) ||
    t("SYS_NAME_SOMEONE", locale);
  const target = (data.targetName as string) || t("SYS_NAME_A_MEMBER", locale);
  const actorId = String(data.actorId ?? data.inviterId ?? "").trim();
  const targetId = String(data.targetUserId ?? data.targetId ?? "").trim();
  const viewer = viewerUserId?.trim() ?? "";
  const isActor = Boolean(viewer && actorId && viewer === actorId);
  const isTarget = Boolean(viewer && targetId && viewer === targetId);
  // A Super Admin is named "Administrator" for every reader, never by the name
  // a legacy row may still carry.
  const byBackoffice = isBackofficeGroupSystemLine(event, data);
  const lineActor = byBackoffice ? administratorActorLabel(locale) : actor;

  switch (event) {
    case "GROUP_CREATED":
      if (isActor) return t("SYS_GROUP_CREATED_SELF", locale);
      return t("SYS_GROUP_CREATED", locale, { actor });

    // v2 chat line: "You added Binh, Chi and Dung" / "An added you" /
    // "An removed Binh"; the push keeps "… to/from {group}".
    case "MEMBER_ADDED":
    case "MEMBER_REMOVED": {
      const youObject = t("SYS_NAME_YOU_OBJECT", locale);
      const grouped =
        event === "MEMBER_ADDED"
          ? groupedTargetLabels(data, viewer, locale, youObject)
          : null;
      return t(
        event === "MEMBER_ADDED" ? "SYS_MEMBER_ADDED" : "SYS_GROUP_MEMBER_REMOVED",
        locale,
        {
          actor: byBackoffice
            ? lineActor
            : isActor
              ? t("SYS_SENDER_YOU", locale)
              : actorId && actorId !== SYSTEM_ACTOR_ID
                ? actor
                : systemActorLabel(locale),
          target: grouped
            ? formatNameList(grouped, locale)
            : isTarget
              ? youObject
              : target,
        }
      );
    }

    case "LEADER_CHANGED":
      if (data.auto === true || !actorId) {
        return isTarget
          ? t("SYS_GROUP_ROLE_ADMIN_SELF", locale)
          : t("SYS_GROUP_ROLE_ADMIN", locale, { target });
      }
      if (isActor) return t("SYS_GROUP_LEADER_MADE_ACTOR", locale, { target });
      if (isTarget) return t("SYS_GROUP_LEADER_MADE_TARGET", locale, { actor });
      return t("SYS_GROUP_LEADER_MADE", locale, { actor, target });

    case "MESSAGE_DELETED": {
      const senderId = String(data.senderId ?? "").trim();
      if (isActor) return t("SYS_MESSAGE_DELETED_ACTOR", locale);
      if (viewer && senderId && viewer === senderId)
        return t("SYS_MESSAGE_DELETED_SENDER", locale, { actor });
      return t("SYS_MESSAGE_DELETED", locale, { actor });
    }

    case "MEMBER_JOINED":
      if (isActor) return t("SYS_GROUP_MEMBER_JOINED_SELF", locale);
      return t("SYS_GROUP_MEMBER_JOINED", locale, { actor });

    case "MEMBER_LEFT":
      if (isActor) return t("SYS_GROUP_MEMBER_LEFT_SELF", locale);
      return t("SYS_GROUP_MEMBER_LEFT", locale, { actor });

    case "MEMBER_BANNED":
      if (isTarget) return t("SYS_GROUP_MEMBER_BANNED_SELF", locale);
      if (isActor)
        return t("SYS_GROUP_MEMBER_BANNED_ACTOR", locale, { target });
      return t("SYS_GROUP_MEMBER_BANNED", locale, {
        actor: lineActor,
        target,
      });

    case "MEMBER_UNBANNED":
      if (isTarget) return t("SYS_GROUP_MEMBER_UNBANNED_SELF", locale);
      if (isActor)
        return t("SYS_GROUP_MEMBER_UNBANNED_ACTOR", locale, { target });
      return t("SYS_GROUP_MEMBER_UNBANNED", locale, {
        actor: lineActor,
        target,
      });

    case "ADMIN_ASSIGNED":
      if (isTarget) return t("SYS_GROUP_ADMIN_ASSIGNED_SELF", locale);
      return t("SYS_GROUP_ADMIN_ASSIGNED", locale, { target });

    case "ADMIN_REMOVED":
      if (isTarget) return t("SYS_GROUP_ROLE_MEMBER_SELF", locale);
      return t("SYS_GROUP_ROLE_MEMBER", locale, { target });

    case "OWNERSHIP_TRANSFERRED":
      if (isActor)
        return t("SYS_GROUP_OWNERSHIP_TRANSFERRED_ACTOR", locale, { target });
      if (isTarget)
        return t("SYS_GROUP_OWNERSHIP_TRANSFERRED_TARGET", locale, { actor });
      return t("SYS_GROUP_OWNERSHIP_TRANSFERRED", locale, { actor, target });

    case "ROLE_CHANGED": {
      const newRole = ((data.newRole as string) || "").toUpperCase();
      const oldRole = ((data.oldRole as string) || "").toUpperCase();
      // Admin promotion is a full hand-off — there is exactly ONE admin per
      // group (mirrors community's "the community admin" phrasing), and it
      // also covers what used to be the separate "Transfer Ownership" action.
      if (newRole === "ADMIN") {
        if (isTarget) return t("SYS_GROUP_ROLE_ADMIN_SELF", locale);
        return t("SYS_GROUP_ROLE_ADMIN", locale, { target });
      }
      if (
        newRole === "MEMBER" &&
        (oldRole === "ADMIN" || oldRole === "MODERATOR")
      ) {
        if (isTarget) return t("SYS_GROUP_ROLE_MEMBER_SELF", locale);
        return t("SYS_GROUP_ROLE_MEMBER", locale, { target });
      }
      const role = groupRoleArticleForm(newRole, locale);
      if (isTarget) return t("SYS_GROUP_ROLE_CHANGED_SELF", locale, { role });
      return t("SYS_GROUP_ROLE_CHANGED", locale, { target, role });
    }

    case "MESSAGE_PINNED":
      if (isActor) return t("SYS_GROUP_MESSAGE_PINNED_SELF", locale);
      return t("SYS_GROUP_MESSAGE_PINNED", locale, { actor });

    case "MESSAGE_UNPINNED":
      if (isActor) return t("SYS_GROUP_MESSAGE_UNPINNED_SELF", locale);
      return t("SYS_GROUP_MESSAGE_UNPINNED", locale, { actor });

    case "ROOM_RENAMED": {
      const name = (data.newName as string) || "";
      if (isActor) {
        return name
          ? t("SYS_GROUP_RENAMED_SELF", locale, { name })
          : t("SYS_GROUP_RENAMED_PLAIN_SELF", locale);
      }
      return name
        ? t("SYS_GROUP_RENAMED", locale, { actor: lineActor, name })
        : t("SYS_GROUP_RENAMED_PLAIN", locale, { actor: lineActor });
    }

    case "AVATAR_CHANGED":
      if (isActor) return t("SYS_GROUP_AVATAR_CHANGED_SELF", locale);
      return t("SYS_GROUP_AVATAR_CHANGED", locale, { actor: lineActor });

    case "DESCRIPTION_CHANGED":
      if (isActor) return t("SYS_GROUP_DESCRIPTION_CHANGED_SELF", locale);
      return t("SYS_GROUP_DESCRIPTION_CHANGED", locale, {
        actor: lineActor,
      });

    case "INVITE_LINK_CREATED":
      if (isActor) return t("SYS_GROUP_INVITE_LINK_CREATED_SELF", locale);
      return t("SYS_GROUP_INVITE_LINK_CREATED", locale, { actor });

    case "GROUP_INVITE":
      if (isActor) return t("SYS_GROUP_INVITE_SHARED_SELF", locale);
      return t("SYS_GROUP_INVITE_SHARED", locale, { actor });

    case "MESSAGES_ENCRYPTED":
      return t("SYS_MESSAGES_ENCRYPTED", locale);

    // Disappearing messages — same wording as the DM line (it names neither a
    // peer nor a group), so both surfaces read identically in every language.
    case "AUTO_DELETE_UPDATED":
      return autoDeleteSystemText(
        data,
        isActor ? t("SYS_SENDER_YOU", locale) : actor,
        locale
      );

    // Group call rows are sender-less lifecycle rows, so the actor-based
    // wording above does not apply — they read exactly like their DM twin.
    case "CALL_STARTED":
    case "CALL_ENDED": {
      // `systemData.callerId` is written by CallChatMessageService, so whenever
      // this is rendered for a known viewer the line can take their side
      // instead of the neutral stored sentence.
      const callerId = String(data.callerId ?? "").trim();
      const direction =
        viewer && callerId ? (viewer === callerId ? "OUTGOING" : "INCOMING") : null;
      const outcome = resolveCallOutcome({
        status: data.status as string,
        durationSec: data.durationSec as number,
      });
      // Only the members who declined read "You declined…"; every other rung
      // member missed it. Rows without `declinedBy` predate the tracking.
      const declinedBy = Array.isArray(data.declinedBy)
        ? data.declinedBy.map(String)
        : null;
      const status =
        direction === "INCOMING" &&
        declinedBy &&
        (outcome === "declined" || outcome === "unanswered")
          ? declinedBy.includes(viewer)
            ? "DECLINED"
            : "MISSED"
          : (data.status as string);
      return buildCallTimelineText({
        callType: data.callType as string,
        status,
        durationSec: data.durationSec as number,
        direction,
        locale,
      });
    }

    default:
      if (isActor) return t("SYS_GROUP_UPDATED_SELF", locale);
      return t("SYS_GROUP_UPDATED", locale, { actor });
  }
}

/** Call duration (contract §9.1): 45s / 2m 14s / 1h 2m, localized. */
export function formatCallDurationText(
  durationSec: number,
  locale: SupportedLocale = STORED_TEXT_LOCALE
): string {
  const total = Math.max(0, Math.floor(Number(durationSec) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  // Zero parts are dropped: 120s → "2m", 3600s → "1h".
  if (hours > 0) {
    return minutes > 0
      ? t("SYS_STREAM_DURATION_HM", locale, { hours, minutes })
      : t("SYS_STREAM_DURATION_H", locale, { hours });
  }
  if (minutes > 0) {
    return seconds > 0
      ? t("SYS_CALL_DURATION_MS", locale, { minutes, seconds })
      : t("SYS_STREAM_DURATION_M", locale, { minutes });
  }
  return t("SYS_CALL_DURATION_S", locale, { seconds });
}

/**
 * Every state a call timeline row can be in, in lifecycle order.
 *
 * A call is ONE chat row that transitions in place (see
 * `CallChatMessageService`): it is written the moment the call starts ringing
 * and updated — same row id, same `callId` — on every subsequent transition.
 * `RINGING` and `ANSWERED` are live states; the rest are terminal.
 */
export const CALL_TIMELINE_STATUSES = [
  "RINGING",
  "ANSWERED",
  "ENDED",
  "MISSED",
  "DECLINED",
  "CANCELLED",
  "FAILED",
  "BUSY",
] as const;

export type CallTimelineStatus = (typeof CALL_TIMELINE_STATUSES)[number];

/**
 * Why a 1:1 call ended — the field every client renders the card from
 * (AIMESS-43 call-card spec §1). Rides on `content.call.endReason` and
 * `systemData.endReason`; `callStatus` stays for older clients.
 */
export const CALL_END_REASONS = [
  "completed",
  "no_answer",
  "declined",
  "canceled",
  "busy",
  "failed",
  "dropped",
] as const;

export type CallEndReason = (typeof CALL_END_REASONS)[number];

/** Server-side end reason for a settled card; null while the call is live. */
export function resolveCallEndReason(params: {
  status: string;
  durationSec?: number | null;
  endedBy?: string | null;
}): CallEndReason | null {
  const status = String(params.status ?? "").toUpperCase();
  const duration = Math.max(0, Math.floor(Number(params.durationSec ?? 0)));
  switch (status) {
    case "RINGING":
    case "ANSWERED":
      return null;
    case "MISSED":
      return "no_answer";
    case "DECLINED":
      return "declined";
    case "CANCELLED":
      return "canceled";
    case "FAILED":
      return "failed";
    case "BUSY":
      return "busy";
    default:
      // A connected call the server tore down (LiveKit/orphan/timeout) is a drop.
      return String(params.endedBy ?? "").startsWith("SYSTEM")
        ? "dropped"
        : duration >= 1
          ? "completed"
          : "failed";
  }
}

/** `dropped` resolves by duration (spec §1): ≥ 1s completed, else failed. */
export function normalizeCallEndReason(
  reason: CallEndReason,
  durationSec?: number | null
): Exclude<CallEndReason, "dropped"> {
  if (reason !== "dropped") return reason;
  return Math.floor(Number(durationSec ?? 0)) >= 1 ? "completed" : "failed";
}

export type CallOutcome = "live" | "connected" | "declined" | "unanswered";

/**
 * The ONE call outcome (contract §9) every builder reads: `endReason` wins over
 * `status`, so a callee rejecting a ring (stored CANCELLED + declined) is
 * declined everywhere, and BUSY / FAILED / CANCELLED / ENDED under 1s are all
 * unanswered.
 */
export function resolveCallOutcome(params: {
  status?: string | null;
  endReason?: string | null;
  durationSec?: number | null;
}): CallOutcome {
  const given = String(params.endReason ?? "").toLowerCase() as CallEndReason;
  const reason = (CALL_END_REASONS as readonly string[]).includes(given)
    ? given
    : resolveCallEndReason({
        status: String(params.status ?? "ENDED"),
        // Unknown duration is not evidence of a failed connect.
        durationSec: params.durationSec ?? 1,
      });
  if (!reason) return "live";
  const normalized = normalizeCallEndReason(reason, params.durationSec);
  if (normalized === "completed") return "connected";
  return normalized === "declined" ? "declined" : "unanswered";
}

/** Per-side phrase of a call that never connected (contract §6). */
function callNotConnectedText(
  outcome: "declined" | "unanswered",
  viewerIsCaller: boolean,
  video: boolean,
  locale: SupportedLocale
): string {
  if (viewerIsCaller) {
    return t(
      outcome === "declined" ? "SYS_CALL_DECLINED_OUTGOING" : "SYS_CALL_NO_ANSWER",
      locale
    );
  }
  if (outcome === "declined") {
    return t(
      video ? "SYS_CALL_DECLINED_INCOMING_VIDEO" : "SYS_CALL_DECLINED_INCOMING_VOICE",
      locale
    );
  }
  return t(
    video ? "SYS_CALL_PREVIEW_MISSED_VIDEO" : "SYS_CALL_PREVIEW_MISSED_VOICE",
    locale
  );
}

/** Conversation-list line per viewer (spec §4) — never shows a duration. */
export function buildCallListPreviewText(params: {
  callType?: string | null;
  endReason?: CallEndReason | null;
  durationSec?: number | null;
  viewerIsCaller: boolean;
  locale?: SupportedLocale;
}): string {
  const locale = params.locale ?? STORED_TEXT_LOCALE;
  const video = String(params.callType ?? "").toUpperCase() === "VIDEO";
  const outcome = resolveCallOutcome({
    endReason: params.endReason,
    durationSec: params.durationSec,
  });
  if (outcome === "declined" || outcome === "unanswered") {
    return callNotConnectedText(outcome, params.viewerIsCaller, video, locale);
  }
  return t(video ? "SYS_CALL_LABEL_VIDEO" : "SYS_CALL_LABEL_VOICE", locale);
}

/** True if the call row has reached a state it can never leave. */
export function isTerminalCallStatus(status: string): boolean {
  const s = String(status ?? "").toUpperCase();
  return s !== "RINGING" && s !== "ANSWERED";
}

/**
 * SINGLE SOURCE OF TRUTH for a call row's text, across private DM rows, group
 * rows, inbox previews and push bodies. Clients render the real card from
 * `content.call` (`callStatus`, `direction`, `durationSec`) — this string only
 * has to be sane wherever raw text is shown.
 */
export function buildCallTimelineText(params: {
  callType?: string | null;
  status?: string | null;
  durationSec?: number | null;
  /**
   * Which end of the call the READER was on, when it is known.
   *
   * A call that never connected has no single honest sentence: the person who
   * placed it got no answer, the person who was rung missed it. Pass this
   * wherever the viewer is known and the line is rendered per reader. Omit it
   * for the STORED text, which is written once and read by both sides — that
   * falls back to the neutral "was not answered".
   */
  direction?: "INCOMING" | "OUTGOING" | null;
  endReason?: string | null;
  locale?: SupportedLocale;
}): string {
  const locale = params.locale ?? STORED_TEXT_LOCALE;
  const label = t(
    String(params.callType ?? "").toUpperCase() === "VIDEO"
      ? "SYS_CALL_LABEL_VIDEO"
      : "SYS_CALL_LABEL_VOICE",
    locale
  );
  const outcome = resolveCallOutcome(params);
  if (outcome === "live") {
    return String(params.status ?? "").toUpperCase() === "RINGING"
      ? t("SYS_CALL_RINGING", locale, { label })
      : t("SYS_CALL_ONGOING", locale, { label });
  }
  if (outcome === "declined" || outcome === "unanswered") {
    // No direction = the stored text both sides read, so it stays neutral.
    if (!params.direction) return t("SYS_CALL_MISSED", locale, { label });
    return callNotConnectedText(
      outcome,
      params.direction === "OUTGOING",
      String(params.callType ?? "").toUpperCase() === "VIDEO",
      locale
    );
  }
  return t("SYS_CALL_ENDED", locale, {
    label,
    duration: formatCallDurationText(Number(params.durationSec ?? 0), locale),
  });
}

/** Shared localized text for Private SYSTEM events. */
export function buildPrivateSystemFallbackText(
  event: string,
  data: Record<string, unknown>,
  viewerUserId?: string | null,
  locale: SupportedLocale = STORED_TEXT_LOCALE
): string {
  const historyLine = conversationHistoryText(event, locale);
  if (historyLine) return historyLine;
  // `inviterId`/`inviterName` is the SAME person under the older field names the
  // two invite writers used before they also wrote `actorId`/`actorName`. Rows
  // persisted then carry only the invite pair, so without this every one of them
  // re-renders as "Someone shared a group invite" forever - in the transcript and
  // in the list preview built from the same snapshot. Read-time projection, so no
  // migration; new rows carry both and never reach the fallback.
  const actor =
    (data.actorName as string) ||
    (data.inviterName as string) ||
    t("SYS_NAME_SOMEONE", locale);
  const target =
    (data.targetName as string) || t("SYS_NAME_SOMEONE_LOWER", locale);
  const actorId = String(data.actorId ?? data.inviterId ?? "").trim();
  const targetId = String(data.targetUserId ?? data.peerId ?? "").trim();
  const viewer = viewerUserId?.trim() ?? "";
  const isActor = Boolean(viewer && actorId && viewer === actorId);
  const isTarget = Boolean(viewer && targetId && viewer === targetId);

  switch (event) {
    case "MESSAGE_PINNED":
      if (isActor) return t("SYS_GROUP_MESSAGE_PINNED_SELF", locale);
      return t("SYS_GROUP_MESSAGE_PINNED", locale, { actor });

    case "MESSAGE_UNPINNED":
      if (isActor) return t("SYS_GROUP_MESSAGE_UNPINNED_SELF", locale);
      return t("SYS_GROUP_MESSAGE_UNPINNED", locale, { actor });

    case "GROUP_INVITE":
      if (isActor) return t("SYS_GROUP_INVITE_SHARED_SELF", locale);
      return t("SYS_GROUP_INVITE_SHARED", locale, { actor });

    // Was missing, so every shared community invite fell through to the
    // `default:` branch and rendered as "{{actor}} updated the chat".
    case "COMMUNITY_INVITE":
      if (isActor) return t("SYS_COMMUNITY_INVITE_SHARED_SELF", locale);
      return t("SYS_COMMUNITY_INVITE_SHARED", locale, { actor });

    case "CALL_STARTED":
    case "CALL_ENDED": {
      const callerId = String(data.callerId ?? "");
      const endReason = (data.endReason as CallEndReason | undefined) ?? null;
      if (viewer && callerId && endReason) {
        return buildCallListPreviewText({
          callType: data.callType as string,
          endReason,
          durationSec: data.durationSec as number,
          viewerIsCaller: viewer === callerId,
          locale,
        });
      }
      return buildCallTimelineText({
        callType: data.callType as string,
        status: data.status as string,
        durationSec: data.durationSec as number,
        direction:
          viewer && callerId
            ? viewer === callerId
              ? "OUTGOING"
              : "INCOMING"
            : null,
        locale,
      });
    }

    case "FRIENDSHIP_CREATED":
      return isActor || isTarget
        ? t("SYS_PRIVATE_FRIENDSHIP_CREATED_SELF", locale, {
            other: isActor ? target : actor,
          })
        : t("SYS_PRIVATE_FRIENDSHIP_CREATED", locale, { actor, target });

    case "FRIENDSHIP_DELETED":
      if (isActor)
        return t("SYS_PRIVATE_FRIENDSHIP_DELETED_ACTOR", locale, { target });
      if (isTarget)
        return t("SYS_PRIVATE_FRIENDSHIP_DELETED_TARGET", locale, { actor });
      return t("SYS_PRIVATE_FRIENDSHIP_DELETED", locale, { actor, target });

    case "FRIENDSHIP_BLOCKED":
      if (isActor)
        return t("SYS_PRIVATE_FRIENDSHIP_BLOCKED_ACTOR", locale, { target });
      if (isTarget)
        return t("SYS_PRIVATE_FRIENDSHIP_BLOCKED_TARGET", locale, { actor });
      return t("SYS_PRIVATE_FRIENDSHIP_BLOCKED", locale, { actor, target });

    case "FRIENDSHIP_BANNED":
      if (isActor)
        return t("SYS_PRIVATE_FRIENDSHIP_BANNED_ACTOR", locale, { target });
      if (isTarget)
        return t("SYS_PRIVATE_FRIENDSHIP_BANNED_TARGET", locale, { actor });
      return t("SYS_PRIVATE_FRIENDSHIP_BANNED", locale, { actor, target });

    case "AUTO_DELETE_UPDATED":
      return autoDeleteSystemText(
        data,
        isActor ? t("SYS_SENDER_YOU", locale) : actor,
        locale
      );

    default:
      if (isActor) return t("SYS_PRIVATE_UPDATED_SELF", locale);
      return t("SYS_PRIVATE_UPDATED", locale, { actor });
  }
}

/**
 * Member whose inbox-list bump preview should read "You …" instead of the
 * third-person line — mirrors `resolveCommunitySystemSubjectUserId`. Only the
 * events where the target's own perspective actually differs from everyone
 * else's need an entry; every other event bumps with the shared text as-is.
 */
export function resolveGroupSystemSubjectUserId(
  event: string,
  data: Record<string, unknown>
): string | null {
  const targetId = String(data.targetUserId ?? data.targetId ?? "").trim();
  switch (event) {
    case "MEMBER_ADDED":
    case "MEMBER_BANNED":
    case "MEMBER_UNBANNED":
    case "OWNERSHIP_TRANSFERRED":
    case "ROLE_CHANGED":
    case "LEADER_CHANGED":
      return targetId || null;
    case "MESSAGE_DELETED":
      return String(data.senderId ?? "").trim() || null;
    default:
      return null;
  }
}

/** Render a persisted group SYSTEM line for one viewer, in their language. */
export function personalizeGroupSystemMessageForViewer(
  event: string,
  systemData: Record<string, unknown>,
  thirdPersonText: string,
  viewerUserId: string,
  locale: SupportedLocale = STORED_TEXT_LOCALE
): string {
  if (!viewerUserId.trim() && locale === STORED_TEXT_LOCALE) {
    return thirdPersonText;
  }
  const personalized = buildGroupSystemFallbackText(
    event,
    systemData,
    viewerUserId,
    locale
  );
  return personalized === thirdPersonText ? thirdPersonText : personalized;
}

/** Render a persisted private SYSTEM line for one viewer, in their language. */
export function personalizePrivateSystemMessageForViewer(
  event: string,
  systemData: Record<string, unknown>,
  thirdPersonText: string,
  viewerUserId: string,
  locale: SupportedLocale = STORED_TEXT_LOCALE
): string {
  if (!viewerUserId.trim() && locale === STORED_TEXT_LOCALE) {
    return thirdPersonText;
  }
  // A call row without a callerId has no viewer side; English keeps its line.
  if (
    (event === "CALL_ENDED" || event === "CALL_STARTED") &&
    locale === STORED_TEXT_LOCALE &&
    !systemData.callerId
  ) {
    return thirdPersonText;
  }
  const personalized = buildPrivateSystemFallbackText(
    event,
    systemData,
    viewerUserId,
    locale
  );
  return personalized === thirdPersonText ? thirdPersonText : personalized;
}
