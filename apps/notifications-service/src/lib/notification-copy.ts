/**
 * Every user-visible notification title/body lives here. Consumers own routing,
 * recipients and payload shape; they never spell copy inline.
 *
 * Voice: title = the subject (a person's name, a community name), body =
 * actor-first sentence case, no trailing period unless the body is multi-sentence.
 */
export interface NotificationCopy {
  title: string;
  body: string;
}

/** Communities are named whenever the payload carries the name; several legacy events don't. */
const UNNAMED_COMMUNITY = "Your community";

const named = (name: string | null | undefined): string =>
  name?.trim() || UNNAMED_COMMUNITY;

const person = (name: string | null | undefined): string =>
  name?.trim() || "Someone";

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "an admin",
  MODERATOR: "a moderator",
  MEMBER: "a member",
};

const mutedUntilFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function formatUntil(iso: string): string | null {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? null
    : `${mutedUntilFormatter.format(at)} UTC`;
}

export const friendCopy = {
  requested: (requesterName?: string): NotificationCopy => ({
    title: person(requesterName),
    body: "Sent you a friend request",
  }),
  acceptedForRequester: (addresseeName?: string): NotificationCopy => ({
    title: person(addresseeName),
    body: "Accepted your friend request",
  }),
  acceptedForAddressee: (requesterName?: string): NotificationCopy => ({
    title: person(requesterName),
    body: "You're now friends",
  }),
  rejected: (addresseeName?: string): NotificationCopy => ({
    title: person(addresseeName),
    body: "Declined your friend request",
  }),
  // Used to update the ADDRESSEE's own friend.requested row in-place on reject.
  // Title is intentionally empty — the gRPC handler preserves the existing title
  // (the requester's name) from the stored notification row.
  rejectedSelf: (): NotificationCopy => ({
    title: "",
    body: "I have declined the friend request.",
  }),
  cancelled: (requesterName?: string): NotificationCopy => ({
    title: person(requesterName),
    body: "Cancelled their friend request",
  }),
};

export const communityCopy = {
  joinRequested: (
    communityName: string,
    requesterName: string
  ): NotificationCopy => ({
    title: named(communityName),
    body: `${person(requesterName)} asked to join`,
  }),
  livestreamStarted: (
    communityName: string,
    hostName: string
  ): NotificationCopy => ({
    title: named(communityName),
    body: `${person(hostName)} is live now`,
  }),
  livestreamEnded: (
    communityName: string,
    hostName: string,
    duration?: string | null
  ): NotificationCopy => ({
    title: named(communityName),
    body: duration
      ? `${person(hostName)} ended the livestream after ${duration}`
      : `${person(hostName)} ended the livestream`,
  }),
  joinRequestApproved: (
    communityName: string,
    decidedByName: string
  ): NotificationCopy => ({
    title: named(communityName),
    body: `${person(decidedByName)} approved your request to join`,
  }),
  joinRequestRejected: (communityName: string): NotificationCopy => ({
    title: named(communityName),
    body: "Your request to join wasn't approved",
  }),
  memberJoined: (communityName: string): NotificationCopy => ({
    title: named(communityName),
    body: "You're now a member",
  }),
  memberAdded: (communityName?: string | null): NotificationCopy => ({
    title: named(communityName),
    body: "You've been added",
  }),
  memberAddedForModerators: (
    communityName?: string | null
  ): NotificationCopy => ({
    title: named(communityName),
    body: "A new member joined",
  }),
  adminTransferred: (): NotificationCopy => ({
    title: UNNAMED_COMMUNITY,
    body: "You're the admin now",
  }),
  roleChanged: (newRole: string): NotificationCopy => ({
    title: UNNAMED_COMMUNITY,
    body: `You're now ${ROLE_LABEL[newRole] ?? newRole.toLowerCase()}`,
  }),
  memberKicked: (): NotificationCopy => ({
    title: UNNAMED_COMMUNITY,
    body: "You've been removed by a moderator",
  }),
  memberBanned: (communityName?: string | null): NotificationCopy => ({
    title: named(communityName),
    body: "You've been banned",
  }),
  memberUnbanned: (): NotificationCopy => ({
    title: UNNAMED_COMMUNITY,
    body: "Your ban has been lifted",
  }),
  memberMuted: (mutedUntil?: string | null): NotificationCopy => {
    const until = mutedUntil ? formatUntil(mutedUntil) : null;
    return {
      title: UNNAMED_COMMUNITY,
      body: until
        ? `You've been muted until ${until}`
        : "You've been muted by a moderator",
    };
  },
  memberUnmuted: (): NotificationCopy => ({
    title: UNNAMED_COMMUNITY,
    body: "You can post again",
  }),
  memberWarned: (note?: string): NotificationCopy => ({
    title: UNNAMED_COMMUNITY,
    body: note?.trim() || "You received a warning from a moderator",
  }),
  inviteSent: (): NotificationCopy => ({
    title: UNNAMED_COMMUNITY,
    body: "You've been invited to join",
  }),
  inviteAccepted: (): NotificationCopy => ({
    title: UNNAMED_COMMUNITY,
    body: "Your invite was accepted",
  }),
  reportCreated: (): NotificationCopy => ({
    title: UNNAMED_COMMUNITY,
    body: "A new report needs review",
  }),
  reportActioned: (): NotificationCopy => ({
    title: UNNAMED_COMMUNITY,
    body: "A moderator reviewed your report",
  }),
  reportResolved: (): NotificationCopy => ({
    title: UNNAMED_COMMUNITY,
    body: "Your report was resolved",
  }),
  deleted: (): NotificationCopy => ({
    title: UNNAMED_COMMUNITY,
    body: "This community was deleted",
  }),
  closed: (): NotificationCopy => ({
    title: UNNAMED_COMMUNITY,
    body: "This community has been closed",
  }),
  reopened: (communityName: string): NotificationCopy => ({
    title: named(communityName),
    body: "This community is open again",
  }),
};

export const chatCopy = {
  message: (params: {
    isCommunity: boolean;
    communityName?: string;
    senderName?: string;
    preview?: string;
  }): NotificationCopy =>
    params.isCommunity
      ? {
          title: params.communityName || params.senderName || "New message",
          body: `${person(params.senderName)}: ${params.preview || "Sent a message"}`,
        }
      : {
          title: params.senderName || "New message",
          body: params.preview || "Sent you a message",
        },
  /** Privacy-masked body used when the recipient turned previews off. */
  messagePreviewHidden: (communityName?: string): string =>
    communityName ? `New message in ${communityName}` : "New message",
};

export const groupCopy = {
  memberAdded: (groupName: string): NotificationCopy => ({
    title: groupName || "New group",
    body: "You were added to the group",
  }),
};

export const callCopy = {
  ringing: (callerName: string, callType: string): NotificationCopy => ({
    title: callerName || "",
    body: callType === "VIDEO" ? "Incoming video call" : "Incoming voice call",
  }),
  /** Data-only dismissal push — deliberately silent. */
  cancelled: (): NotificationCopy => ({ title: "", body: "" }),
};

export const authCopy = {
  newLogin: (device?: string | null, location?: string | null) => {
    const where = location
      ? `${device || "A new device"} · ${location}`
      : device || "A new device";
    return {
      title: "New login",
      body: `${where}. Not you? Review your devices.`,
    } satisfies NotificationCopy;
  },
  passwordChanged: (): NotificationCopy => ({
    title: "Password changed",
    body: "Your password was updated",
  }),
  emailChanged: (): NotificationCopy => ({
    title: "Email changed",
    body: "Your account email was updated",
  }),
};
