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
 */
import {
  buildCallActivityText,
  t,
  type CallActivityDirection,
  type SupportedLocale,
} from "@aimess/constants";

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

/** A copy builder deferred until the recipient (and so their language) is known. */
export type LocalizedCopy = (locale: SupportedLocale) => NotificationCopy;

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
export const friendCopy = {
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
};

// Community rows carry the community avatar and a community badge; the body
// names the community itself, so a separate heading would just repeat it.
export const communityCopy = {
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
};

export const chatCopy = {
  message:
    (params: {
      isCommunity: boolean;
      communityName?: string;
      /** GROUP rooms only — titles the push on the group, like a community. */
      groupName?: string;
      senderName?: string;
      preview?: string;
    }): LocalizedCopy =>
    (locale) => {
      // A message in a NAMED room (community or group) titles on the room and
      // puts the sender in the body ("Family Group 2026" / "Ana: hey"); a 1:1
      // titles on the sender. Same shape for both room kinds — the only
      // difference is which name the producer resolved.
      const roomName = params.isCommunity
        ? params.communityName
        : params.groupName;
      return roomName
        ? {
            title: roomName,
            body: t("NOTIF_CHAT_COMMUNITY_BODY", locale, {
              name: person(params.senderName, locale),
              preview: params.preview || t("NOTIF_CHAT_SENT_A_MESSAGE", locale),
            }),
          }
        : {
            title: params.senderName || t("NOTIF_CHAT_NEW_MESSAGE", locale),
            body:
              params.preview ||
              t(
                params.isCommunity
                  ? "NOTIF_CHAT_SENT_A_MESSAGE"
                  : "NOTIF_CHAT_SENT_YOU_A_MESSAGE",
                locale
              ),
          };
    },
  /** Privacy-masked body used when the recipient turned previews off. */
  messagePreviewHidden: (
    roomName: string | undefined,
    locale: SupportedLocale
  ): string =>
    roomName
      ? t("NOTIF_CHAT_NEW_MESSAGE_IN", locale, { community: roomName })
      : t("NOTIF_CHAT_NEW_MESSAGE", locale),
};

export const groupCopy = {
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
};

export const callCopy = {
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
};

export const authCopy = {
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
};
