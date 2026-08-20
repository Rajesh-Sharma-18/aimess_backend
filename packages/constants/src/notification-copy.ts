/**
 * Every user-visible notification title/body lives here. Consumers own routing,
 * recipients and payload shape; they never spell copy inline.
 *
 * Voice: title = the subject (a person's name, a community name), body =
 * actor-first sentence case, no trailing period unless the body is multi-sentence.
 *
 * LOCALE: every builder takes the RECIPIENT's locale as its last argument.
 * Consumers do not resolve it — they hand `pushToUser` a `copy(locale)` thunk
 * and `pushToUser` calls it once it knows who the recipient is, so one event
 * fanned out to an English, a Vietnamese and a Thai user produces three
 * different strings. See `push.service.ts`.
 *
 * WHY THIS LIVES IN `@aimess/constants` AND NOT IN notifications-service:
 * a notification row persists the RENDERED sentence, so the language it was
 * written in used to be the language it read in forever — switching the app to
 * English left every historical row in Vietnamese. Rendering is therefore
 * deferred to READ time as well as write time, and the reader
 * (chat-service's notification serializer, the gateway's `/notify` relay) is in
 * a different process from the writer. Both ends now import these builders from
 * here and replay them through {@link renderNotificationCopy}.
 */
import { t } from "./i18n.js";
import { localizeMessagePreview } from "./message-preview.js";
import {
  buildCallActivityText,
  type CallActivityDirection,
} from "./chat/call-activity-text.js";
import type { SupportedLocale } from "./locale.js";

export type { CallActivityDirection };

export interface NotificationCopy {
  /** Tray/FCM heading — always present, the OS requires one. */
  title: string;
  body: string;
  /**
   * Notification-Center heading. `null` means the row renders WITHOUT a heading
   * because the body is already a complete, self-describing sentence — forcing
   * a title there is what makes an inbox read like a list of identical cards.
   * Omit to reuse `title`.
   */
  inboxTitle?: string | null;
}

/**
 * A replay ticket for one copy builder: which builder, and the exact arguments
 * it was called with. Persisted as JSON on the notification row (`data.copyRef`)
 * so any process holding the row can re-render the sentence in whatever
 * language the reader is using RIGHT NOW.
 *
 * Only the arguments are stored, never the rendered text — which is the whole
 * point: names and ids are data (never translated), the sentence around them is
 * copy (always re-rendered).
 */
export interface CopyDescriptor {
  /** `"<namespace>.<builder>"`, e.g. `"call.activity"`. */
  ref: string;
  /** The builder's own arguments, JSON round-trippable. */
  args: unknown[];
}

/**
 * A copy builder deferred until the recipient (and so their language) is known.
 * Carries the {@link CopyDescriptor} that produced it — attached by
 * {@link register}, so no builder has to remember to declare it.
 */
export type LocalizedCopy = ((locale: SupportedLocale) => NotificationCopy) & {
  descriptor?: CopyDescriptor;
};

/**
 * Same deferral for `data` entries that are user-facing TEXT rather than ids —
 * today just the friend-card `resolution` line.
 */
export type LocalizedData = ((
  locale: SupportedLocale
) => Record<string, string>) & {
  descriptor?: CopyDescriptor;
};

type Replayable = (...args: never[]) => (locale: SupportedLocale) => unknown;

/**
 * ref → builder. The ref strings are a PERSISTED CONTRACT: they are written
 * into notification rows, so renaming a builder (or its namespace) orphans
 * every row that already points at it. Those rows fall back to their stored
 * text rather than breaking, but they stop following the reader's language —
 * so treat a rename as a data migration, not a refactor.
 */
const REGISTRY = new Map<string, Replayable>();

/**
 * Wrap a namespace of copy builders so each one records how it was called.
 *
 * Generic on purpose: capturing the arguments here means a builder can branch
 * internally (mute-with-expiry vs. indefinite, the six call outcomes) and the
 * replay still lands on the same branch, because it re-runs the builder rather
 * than trying to reconstruct its output.
 */
function register<
  T extends Record<
    string,
    (...args: never[]) => (locale: SupportedLocale) => unknown
  >,
>(namespace: string, builders: T): T {
  const wrapped: Record<string, unknown> = {};
  for (const [name, build] of Object.entries(builders)) {
    const ref = `${namespace}.${name}`;
    REGISTRY.set(ref, build as Replayable);
    wrapped[name] = (...args: unknown[]) => {
      const thunk = (build as (...a: unknown[]) => unknown)(
        ...args
      ) as LocalizedCopy;
      thunk.descriptor = { ref, args };
      return thunk;
    };
  }
  return wrapped as T;
}

/**
 * `JSON.stringify` turns a trailing `undefined` argument into `null`; the
 * builders all expect `string | undefined` and treat an empty value as "fall
 * back". Normalizing on the way back in keeps a replayed call byte-identical to
 * the original one.
 */
function replay(
  raw: string | undefined | null,
  locale: SupportedLocale
): unknown {
  if (!raw) return null;
  let parsed: CopyDescriptor;
  try {
    parsed = JSON.parse(raw) as CopyDescriptor;
  } catch {
    return null;
  }
  const build = REGISTRY.get(parsed?.ref ?? "");
  if (!build) return null;
  const args = (Array.isArray(parsed.args) ? parsed.args : []).map((a) =>
    a === null ? undefined : a
  );
  try {
    return (build as (...a: unknown[]) => (l: SupportedLocale) => unknown)(
      ...args
    )(locale);
  } catch {
    // A malformed/legacy descriptor must degrade to the row's stored text, never
    // take the notification list down with it.
    return null;
  }
}

/**
 * Re-render a notification's title/body in `locale` from its stored
 * `data.copyRef`. `null` means "no usable descriptor" — the caller keeps the
 * text baked into the row, which is exactly what every row written before this
 * existed relies on.
 */
export function renderNotificationCopy(
  copyRef: string | undefined | null,
  locale: SupportedLocale
): NotificationCopy | null {
  const out = replay(copyRef, locale);
  return out && typeof out === "object" && "body" in out
    ? (out as NotificationCopy)
    : null;
}

/** Re-render the localized `data` entries (the `resolution` line) in `locale`. */
export function renderNotificationData(
  dataRef: string | undefined | null,
  locale: SupportedLocale
): Record<string, string> | null {
  const out = replay(dataRef, locale);
  return out && typeof out === "object" && !("body" in out)
    ? (out as Record<string, string>)
    : null;
}

/** `data` keys holding a replay ticket rather than content. */
export const COPY_REF_KEY = "copyRef";
export const DATA_REF_KEY = "dataRef";

/** Communities are named whenever the payload carries the name; several legacy events don't. */
const named = (
  name: string | null | undefined,
  locale: SupportedLocale
): string => name?.trim() || t("NOTIF_UNNAMED_COMMUNITY", locale);

const person = (
  name: string | null | undefined,
  locale: SupportedLocale
): string => name?.trim() || t("SYS_NAME_SOMEONE", locale);

function roleLabel(role: string, locale: SupportedLocale): string {
  const r = String(role ?? "").toUpperCase();
  if (r === "ADMIN") return t("SYS_ROLE_ADMIN_ARTICLE", locale);
  if (r === "MODERATOR") return t("SYS_ROLE_MODERATOR_ARTICLE", locale);
  if (r === "MEMBER") return t("SYS_ROLE_MEMBER_ARTICLE", locale);
  return role.toLowerCase();
}

const INTL_LOCALE: Record<SupportedLocale, string> = {
  en: "en-US",
  vi: "vi-VN",
  th: "th-TH",
};

function formatUntil(iso: string, locale: SupportedLocale): string | null {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? null
    : `${new Intl.DateTimeFormat(INTL_LOCALE[locale], {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(at)} UTC`;
}

// Social rows are self-describing sentences that already name the person and
// carry their avatar — a heading above them adds nothing, so inboxTitle is null.
export const friendCopy = register("friend", {
  requested:
    (requesterName?: string): LocalizedCopy =>
    (locale) => ({
      title: person(requesterName, locale),
      body: t("NOTIF_FRIEND_REQUESTED", locale, {
        name: person(requesterName, locale),
      }),
      inboxTitle: null,
    }),
  acceptedForRequester:
    (addresseeName?: string): LocalizedCopy =>
    (locale) => ({
      title: person(addresseeName, locale),
      body: t("NOTIF_FRIEND_ACCEPTED_FOR_REQUESTER", locale, {
        name: person(addresseeName, locale),
      }),
      inboxTitle: null,
    }),
  acceptedForAddressee:
    (requesterName?: string): LocalizedCopy =>
    (locale) => ({
      title: person(requesterName, locale),
      body: t("NOTIF_FRIEND_ACCEPTED_FOR_ADDRESSEE", locale, {
        name: person(requesterName, locale),
      }),
      inboxTitle: null,
    }),
  rejected:
    (addresseeName?: string): LocalizedCopy =>
    (locale) => ({
      title: person(addresseeName, locale),
      body: t("NOTIF_FRIEND_REJECTED", locale, {
        name: person(addresseeName, locale),
      }),
      inboxTitle: null,
    }),
  rejectedSelf:
    (requesterName?: string): LocalizedCopy =>
    (locale) => ({
      title: person(requesterName, locale),
      body: t("NOTIF_FRIEND_REJECTED_SELF", locale, {
        name: person(requesterName, locale),
      }),
      inboxTitle: null,
    }),
  cancelled:
    (requesterName?: string): LocalizedCopy =>
    (locale) => ({
      title: person(requesterName, locale),
      body: t("NOTIF_FRIEND_CANCELLED", locale, {
        name: person(requesterName, locale),
      }),
      inboxTitle: null,
    }),
});

// Community rows carry the community avatar and a community badge; the body
// names the community itself, so a separate heading would just repeat it.
/**
 * The friend-card `resolution` line — the terminal outcome printed under a
 * request once it has been accepted / declined / cancelled.
 *
 * It rides `data.resolution` rather than the body, so it needs its own
 * registered namespace to be replayable; consumers used to spell these as inline
 * `localizedData` closures, which a closure cannot describe and therefore froze
 * the line in the language it was written in.
 */
export const resolutionCopy = register("resolution", {
  friendAccepted:
    (name?: string): LocalizedData =>
    (locale) => ({
      resolution: t("NOTIF_FRIEND_RESOLUTION_ACCEPTED", locale, {
        name: person(name, locale),
      }),
    }),
  friendNowFriends: (): LocalizedData => (locale) => ({
    resolution: t("NOTIF_FRIEND_RESOLUTION_NOW_FRIENDS", locale),
  }),
  friendDeclined: (): LocalizedData => (locale) => ({
    resolution: t("NOTIF_FRIEND_RESOLUTION_DECLINED", locale),
  }),
  friendDeclinedSelf: (): LocalizedData => (locale) => ({
    resolution: t("NOTIF_FRIEND_RESOLUTION_DECLINED_SELF", locale),
  }),
  friendCancelled: (): LocalizedData => (locale) => ({
    resolution: t("NOTIF_FRIEND_RESOLUTION_CANCELLED", locale),
  }),
});

export const communityCopy = register("community", {
  joinRequested:
    (communityName: string, requesterName: string): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_JOIN_REQUESTED", locale, {
        name: person(requesterName, locale),
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
  livestreamStarted:
    (communityName: string, hostName: string): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_LIVESTREAM_STARTED", locale, {
        name: person(hostName, locale),
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
  livestreamEnded:
    (
      communityName: string,
      hostName: string,
      duration?: string | null
    ): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body:
        duration && !/^0[smh]?$/.test(duration.trim())
          ? t("NOTIF_COMMUNITY_LIVESTREAM_ENDED_DURATION", locale, {
              name: person(hostName, locale),
              community: named(communityName, locale),
              duration,
            })
          : t("NOTIF_COMMUNITY_LIVESTREAM_ENDED", locale, {
              name: person(hostName, locale),
              community: named(communityName, locale),
            }),
      inboxTitle: null,
    }),
  joinRequestApproved:
    (communityName: string, decidedByName: string): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_JOIN_REQUEST_APPROVED", locale, {
        name: person(decidedByName, locale),
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
  joinRequestRejected:
    (communityName: string): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_JOIN_REQUEST_REJECTED", locale, {
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
  memberJoined:
    (communityName: string): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_MEMBER_JOINED", locale, {
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
  memberAdded:
    (communityName?: string | null): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_MEMBER_ADDED", locale, {
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
  memberAddedForModerators:
    (communityName?: string | null): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_MEMBER_ADDED_FOR_MODERATORS", locale, {
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
  adminTransferred:
    (communityName?: string | null): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_ADMIN_TRANSFERRED", locale, {
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
  roleChanged:
    (newRole: string, communityName?: string | null): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_ROLE_CHANGED", locale, {
        role: roleLabel(newRole, locale),
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
  memberKicked:
    (communityName?: string | null): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_MEMBER_KICKED", locale, {
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
  memberBanned:
    (communityName?: string | null): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_MEMBER_BANNED", locale, {
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
  memberUnbanned:
    (communityName?: string | null): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_MEMBER_UNBANNED", locale, {
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
  memberMuted:
    (
      mutedUntil?: string | null,
      communityName?: string | null
    ): LocalizedCopy =>
    (locale) => {
      const until = mutedUntil ? formatUntil(mutedUntil, locale) : null;
      return {
        title: named(communityName, locale),
        body: until
          ? t("NOTIF_COMMUNITY_MEMBER_MUTED_UNTIL", locale, {
              community: named(communityName, locale),
              until,
            })
          : t("NOTIF_COMMUNITY_MEMBER_MUTED", locale, {
              community: named(communityName, locale),
            }),
        inboxTitle: null,
      };
    },
  memberUnmuted:
    (communityName?: string | null): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_MEMBER_UNMUTED", locale, {
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
  memberWarned:
    (note?: string, communityName?: string | null): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      // A moderator's free-text warning is user-authored content, not product
      // copy — it is shown verbatim and never translated.
      body:
        note?.trim() ||
        t("NOTIF_COMMUNITY_MEMBER_WARNED", locale, {
          community: named(communityName, locale),
        }),
      inboxTitle: null,
    }),
  inviteSent:
    (communityName?: string | null): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_INVITE_SENT", locale, {
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
  inviteAccepted:
    (communityName?: string | null): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_INVITE_ACCEPTED", locale, {
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
  reportCreated:
    (communityName?: string | null): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_REPORT_CREATED", locale, {
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
  reportActioned:
    (communityName?: string | null): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_REPORT_ACTIONED", locale, {
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
  reportResolved:
    (communityName?: string | null): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_REPORT_RESOLVED", locale, {
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
  deleted:
    (communityName?: string | null): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_DELETED", locale, {
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
  closed:
    (communityName?: string | null): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_CLOSED", locale, {
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
  reopened:
    (communityName: string): LocalizedCopy =>
    (locale) => ({
      title: named(communityName, locale),
      body: t("NOTIF_COMMUNITY_REOPENED", locale, {
        community: named(communityName, locale),
      }),
      inboxTitle: null,
    }),
});

export const chatCopy = register("chat", {
  message:
    (params: {
      isCommunity: boolean;
      communityName?: string;
      /** GROUP rooms only — titles the push on the group, like a community. */
      groupName?: string;
      senderName?: string;
      /** Built in `STORED_TEXT_LOCALE` by the producer — one preview, many
       *  recipient languages. A pure media LABEL ("🎤 Voice Message") is
       *  re-rendered per recipient below; message text is never touched. */
      preview?: string;
      /** Canonical content type behind `preview`, for that re-render. */
      messageType?: string;
    }): LocalizedCopy =>
    (locale) => {
      // A message in a NAMED room (community or group) titles on the room and
      // puts the sender in the body ("Family Group 2026" / "Ana: hey"); a 1:1
      // titles on the sender. Same shape for both room kinds — the only
      // difference is which name the producer resolved.
      const roomName = params.isCommunity
        ? params.communityName
        : params.groupName;
      const preview = localizeMessagePreview(
        params.preview,
        params.messageType,
        locale
      );
      return roomName
        ? {
            title: roomName,
            body: t("NOTIF_CHAT_COMMUNITY_BODY", locale, {
              name: person(params.senderName, locale),
              preview: preview || t("NOTIF_CHAT_SENT_A_MESSAGE", locale),
            }),
          }
        : {
            title: params.senderName || t("NOTIF_CHAT_NEW_MESSAGE", locale),
            body:
              preview ||
              t(
                params.isCommunity
                  ? "NOTIF_CHAT_SENT_A_MESSAGE"
                  : "NOTIF_CHAT_SENT_YOU_A_MESSAGE",
                locale
              ),
          };
    },
});

/**
 * Privacy-masked body used when the recipient turned previews off. Not a copy
 * BUILDER (it renders straight to a string, and chat pushes never write an
 * inbox row) so it stays outside the replay registry.
 */
export const chatPreviewHiddenBody = (
  roomName: string | undefined,
  locale: SupportedLocale
): string =>
  roomName
    ? t("NOTIF_CHAT_NEW_MESSAGE_IN", locale, { community: roomName })
    : t("NOTIF_CHAT_NEW_MESSAGE", locale);

export const groupCopy = register("group", {
  memberAdded:
    (groupName: string): LocalizedCopy =>
    (locale) => ({
      title: groupName || t("NOTIF_GROUP_UNNAMED", locale),
      body: t("NOTIF_GROUP_MEMBER_ADDED", locale),
    }),
  // Word-for-word the community mute copy, with "group" in place of the
  // community name — see communityCopy.memberMuted/memberUnmuted.
  memberMuted:
    (groupName: string, mutedUntil?: string | null): LocalizedCopy =>
    (locale) => {
      const until = mutedUntil ? formatUntil(mutedUntil, locale) : null;
      const name = groupName || t("NOTIF_GROUP_THIS_GROUP", locale);
      return {
        title: name,
        body: until
          ? t("NOTIF_GROUP_MEMBER_MUTED_UNTIL", locale, { group: name, until })
          : t("NOTIF_GROUP_MEMBER_MUTED", locale, { group: name }),
      };
    },
  memberUnmuted:
    (groupName: string): LocalizedCopy =>
    (locale) => {
      const name = groupName || t("NOTIF_GROUP_THIS_GROUP", locale);
      return {
        title: name,
        body: t("NOTIF_GROUP_MEMBER_UNMUTED", locale, { group: name }),
      };
    },
});

export const callCopy = register("call", {
  ringing:
    (callerName: string, callType: string): LocalizedCopy =>
    (locale) => ({
      title: callerName || "",
      body: t(
        callType === "VIDEO"
          ? "NOTIF_CALL_INCOMING_VIDEO"
          : "NOTIF_CALL_INCOMING_VOICE",
        locale
      ),
    }),
  missed:
    (callerName: string, callType: string): LocalizedCopy =>
    (locale) => ({
      title: callerName || "",
      body: t(
        callType === "VIDEO"
          ? "NOTIF_CALL_MISSED_VIDEO"
          : "NOTIF_CALL_MISSED_VOICE",
        locale
      ),
    }),
  /** Data-only dismissal push — deliberately silent. */
  cancelled: (): LocalizedCopy => () => ({ title: "", body: "" }),
  /**
   * Notification-Center call-history line. The sentence is built by the shared
   * `buildCallActivityText` mapper so the Notification Center, the DM timeline
   * card and the conversation-list preview all describe one call the same way.
   * `peerName` is data (a person's name), so it is the title, not copy.
   */
  activity:
    (
      peerName: string,
      callType: string,
      status: string,
      direction: CallActivityDirection,
      durationSec: number,
      ringDurationSec?: number | null
    ): LocalizedCopy =>
    (locale) => ({
      title: peerName || "",
      body: buildCallActivityText({
        callType,
        status,
        direction,
        durationSec,
        ringDurationSec,
        locale,
      }),
    }),
});

export const authCopy = register("auth", {
  newLogin:
    (browser?: string | null, location?: string | null): LocalizedCopy =>
    (locale) => {
      const device = browser
        ? t("NOTIF_AUTH_ON_BROWSER", locale, { browser: browser.toLowerCase() })
        : t("NOTIF_AUTH_NEW_DEVICE", locale);
      return {
        title: t("NOTIF_AUTH_LOGIN_DETECTED_TITLE", locale),
        body: location
          ? t("NOTIF_AUTH_NEW_LOGIN_LOCATION", locale, { device, location })
          : t("NOTIF_AUTH_NEW_LOGIN", locale, { device }),
      };
    },
  passwordChanged: (): LocalizedCopy => (locale) => ({
    title: t("NOTIF_AUTH_PASSWORD_CHANGED_TITLE", locale),
    body: t("NOTIF_AUTH_PASSWORD_CHANGED_BODY", locale),
  }),
  emailChanged: (): LocalizedCopy => (locale) => ({
    title: t("NOTIF_AUTH_EMAIL_CHANGED_TITLE", locale),
    body: t("NOTIF_AUTH_EMAIL_CHANGED_BODY", locale),
  }),
});
