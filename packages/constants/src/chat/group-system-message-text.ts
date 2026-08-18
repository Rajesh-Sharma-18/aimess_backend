import { resolvePersonDisplayName } from "../community/system-message-text.js";
import { t } from "../i18n.js";
import { STORED_TEXT_LOCALE, type SupportedLocale } from "../locale.js";

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
};

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
 * How many names a grouped system line spells out before collapsing the rest
 * into "and N others" (WhatsApp behaviour — a 50-member add must not render a
 * 50-name bubble).
 */
const GROUPED_NAME_LIMIT = 3;

/** "A", "A and B", "A, B and C", "A, B, C and 3 others". */
function formatNameList(labels: string[], locale: SupportedLocale): string {
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
 * as "you" and hoisted to the front so they still see themselves named even
 * when the list overflows into "and N others".
 */
function groupedTargetLabels(
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
    self!.label = t("SYS_NAME_YOU_OBJECT", locale);
    entries.unshift(self!);
  }
  return entries.map((entry) => entry.label);
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
  const actor = (data.actorName as string) || t("SYS_NAME_SOMEONE", locale);
  const target = (data.targetName as string) || t("SYS_NAME_A_MEMBER", locale);
  const actorId = String(data.actorId ?? "").trim();
  const targetId = String(data.targetUserId ?? "").trim();
  const viewer = viewerUserId?.trim() ?? "";
  const isActor = Boolean(viewer && actorId && viewer === actorId);
  const isTarget = Boolean(viewer && targetId && viewer === targetId);

  switch (event) {
    case "GROUP_CREATED":
      if (isActor) return t("SYS_GROUP_CREATED_SELF", locale);
      return t("SYS_GROUP_CREATED", locale, { actor });

    case "MEMBER_ADDED": {
      // Batch add (one operation, many members) → ONE grouped line. The actor is
      // the same for every viewer; only the wording is personalized.
      const grouped = groupedTargetLabels(data, viewer, locale);
      if (grouped) {
        const targets = formatNameList(grouped, locale);
        return isActor
          ? t("SYS_GROUP_MEMBERS_ADDED_SELF", locale, { targets })
          : t("SYS_GROUP_MEMBERS_ADDED", locale, { actor, targets });
      }
      if (isTarget) return t("SYS_GROUP_MEMBER_ADDED_SELF", locale);
      if (isActor)
        return t("SYS_GROUP_MEMBERS_ADDED_SELF", locale, { targets: target });
      return t("SYS_GROUP_MEMBER_ADDED", locale, { actor, target });
    }

    case "MEMBER_JOINED":
      if (isActor) return t("SYS_GROUP_MEMBER_JOINED_SELF", locale);
      return t("SYS_GROUP_MEMBER_JOINED", locale, { actor });

    case "MEMBER_LEFT":
      if (isActor) return t("SYS_GROUP_MEMBER_LEFT_SELF", locale);
      return t("SYS_GROUP_MEMBER_LEFT", locale, { actor });

    case "MEMBER_REMOVED":
      if (isTarget) return t("SYS_GROUP_MEMBER_REMOVED_SELF", locale);
      return t("SYS_GROUP_MEMBER_REMOVED", locale, { actor, target });

    case "MEMBER_BANNED":
      if (isTarget) return t("SYS_GROUP_MEMBER_BANNED_SELF", locale);
      return t("SYS_GROUP_MEMBER_BANNED", locale, { actor, target });

    case "MEMBER_UNBANNED":
      if (isTarget) return t("SYS_GROUP_MEMBER_UNBANNED_SELF", locale);
      return t("SYS_GROUP_MEMBER_UNBANNED", locale, { actor, target });

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
        ? t("SYS_GROUP_RENAMED", locale, { actor, name })
        : t("SYS_GROUP_RENAMED_PLAIN", locale, { actor });
    }

    case "AVATAR_CHANGED":
      if (isActor) return t("SYS_GROUP_AVATAR_CHANGED_SELF", locale);
      return t("SYS_GROUP_AVATAR_CHANGED", locale, { actor });

    case "DESCRIPTION_CHANGED":
      if (isActor) return t("SYS_GROUP_DESCRIPTION_CHANGED_SELF", locale);
      return t("SYS_GROUP_DESCRIPTION_CHANGED", locale, { actor });

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

    default:
      if (isActor) return t("SYS_GROUP_UPDATED_SELF", locale);
      return t("SYS_GROUP_UPDATED", locale, { actor });
  }
}

export function formatCallDuration(durationSec: number): string {
  const total = Math.max(0, Math.floor(durationSec));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${mm}:${ss}`
    : `${mm}:${ss}`;
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
] as const;

export type CallTimelineStatus = (typeof CALL_TIMELINE_STATUSES)[number];

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
  locale?: SupportedLocale;
}): string {
  const locale = params.locale ?? STORED_TEXT_LOCALE;
  const label = t(
    String(params.callType ?? "").toUpperCase() === "VIDEO"
      ? "SYS_CALL_LABEL_VIDEO"
      : "SYS_CALL_LABEL_VOICE",
    locale
  );
  const status = String(params.status ?? "ENDED").toUpperCase();
  switch (status) {
    case "RINGING":
      return t("SYS_CALL_RINGING", locale, { label });
    case "ANSWERED":
      return t("SYS_CALL_ONGOING", locale, { label });
    // One rule for every call that never connected, whoever ended it. AiMess
    // has no user-facing "cancelled" or "declined" call — see
    // `buildCallActivityText`, which resolves the same three outcomes the same
    // way for the Notification Center. Without a direction this is the stored
    // text both participants read, so it stays neutral rather than picking a
    // side.
    case "DECLINED":
    case "CANCELLED":
    case "FAILED":
    case "MISSED": {
      if (params.direction === "OUTGOING")
        return t("SYS_CALL_NO_ANSWER", locale, { label });
      if (params.direction === "INCOMING")
        return t("SYS_CALL_MISSED_CALL", locale, { label });
      return t("SYS_CALL_MISSED", locale, { label });
    }
    default:
      // Title-cased label here only: this line stands alone as the chat-list
      // preview and must read exactly like the card's heading, unlike every
      // branch above where the label sits inside a sentence.
      return t("SYS_CALL_ENDED", locale, {
        label: t(
          String(params.callType ?? "").toUpperCase() === "VIDEO"
            ? "SYS_CALL_TITLE_VIDEO"
            : "SYS_CALL_TITLE_VOICE",
          locale
        ),
        duration: formatCallDuration(Number(params.durationSec ?? 0)),
      });
  }
}

/** Shared localized text for Private SYSTEM events. */
export function buildPrivateSystemFallbackText(
  event: string,
  data: Record<string, unknown>,
  viewerUserId?: string | null,
  locale: SupportedLocale = STORED_TEXT_LOCALE
): string {
  const actor = (data.actorName as string) || t("SYS_NAME_SOMEONE", locale);
  const target =
    (data.targetName as string) || t("SYS_NAME_SOMEONE_LOWER", locale);
  const actorId = String(data.actorId ?? "").trim();
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
    case "CALL_ENDED":
      return buildCallTimelineText({
        callType: data.callType as string,
        status: data.status as string,
        durationSec: data.durationSec as number,
        locale,
      });

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
  const targetId = String(data.targetUserId ?? "").trim();
  switch (event) {
    case "MEMBER_ADDED":
    case "MEMBER_BANNED":
    case "MEMBER_UNBANNED":
    case "OWNERSHIP_TRANSFERRED":
    case "ROLE_CHANGED":
      return targetId || null;
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
  // Call rows carry no viewer-relative wording, but they DO need translating —
  // only the personalization pass is skipped, not the locale rebuild.
  if (
    (event === "CALL_ENDED" || event === "CALL_STARTED") &&
    locale === STORED_TEXT_LOCALE
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
