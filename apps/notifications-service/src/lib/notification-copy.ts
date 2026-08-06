/**
 * Every user-visible notification title/body lives here. Consumers own routing,
 * recipients and payload shape; they never spell copy inline.
 *
 * Voice: title = the subject (a person's name, a community name), body =
 * actor-first sentence case, no trailing period unless the body is multi-sentence.
 */
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

// Social rows are self-describing sentences that already name the person and
// carry their avatar — a heading above them adds nothing, so inboxTitle is null.
export const friendCopy = {
  requested: (requesterName?: string): NotificationCopy => ({
    title: person(requesterName),
    body: `${person(requesterName)} sent you a friend request`,
    inboxTitle: null,
  }),
  acceptedForRequester: (addresseeName?: string): NotificationCopy => ({
    title: person(addresseeName),
    body: `${person(addresseeName)} accepted your friend request`,
    inboxTitle: null,
  }),
  acceptedForAddressee: (requesterName?: string): NotificationCopy => ({
    title: person(requesterName),
    body: `You and ${person(requesterName)} are now friends`,
    inboxTitle: null,
  }),
  rejected: (addresseeName?: string): NotificationCopy => ({
    title: person(addresseeName),
    body: `${person(addresseeName)} declined your friend request`,
    inboxTitle: null,
  }),
  rejectedSelf: (requesterName?: string): NotificationCopy => ({
    title: person(requesterName),
    body: `You declined ${person(requesterName)}'s friend request`,
    inboxTitle: null,
  }),
  cancelled: (requesterName?: string): NotificationCopy => ({
    title: person(requesterName),
    body: `${person(requesterName)} cancelled their friend request`,
    inboxTitle: null,
  }),
};

// Community rows carry the community avatar and a community badge; the body
// names the community itself, so a separate heading would just repeat it.
export const communityCopy = {
  joinRequested: (
    communityName: string,
    requesterName: string
  ): NotificationCopy => ({
    title: named(communityName),
    body: `${person(requesterName)} asked to join ${named(communityName)}`,
    inboxTitle: null,
  }),
  livestreamStarted: (
    communityName: string,
    hostName: string
  ): NotificationCopy => ({
    title: named(communityName),
    body: `${person(hostName)} is live in ${named(communityName)}`,
    inboxTitle: null,
  }),
  livestreamEnded: (
    communityName: string,
    hostName: string,
    duration?: string | null
  ): NotificationCopy => ({
    title: named(communityName),
    body:
      duration && !/^0[smh]?$/.test(duration.trim())
        ? `${person(hostName)} ended the livestream in ${named(communityName)} after ${duration}`
        : `${person(hostName)} ended the livestream in ${named(communityName)}`,
    inboxTitle: null,
  }),
  joinRequestApproved: (
    communityName: string,
    decidedByName: string
  ): NotificationCopy => ({
    title: named(communityName),
    body: `${person(decidedByName)} approved your request to join ${named(communityName)}`,
    inboxTitle: null,
  }),
  joinRequestRejected: (communityName: string): NotificationCopy => ({
    title: named(communityName),
    body: `Your request to join ${named(communityName)} wasn't approved`,
    inboxTitle: null,
  }),
  memberJoined: (communityName: string): NotificationCopy => ({
    title: named(communityName),
    body: `You're now a member of ${named(communityName)}`,
    inboxTitle: null,
  }),
  memberAdded: (communityName?: string | null): NotificationCopy => ({
    title: named(communityName),
    body: `You were added to ${named(communityName)}`,
    inboxTitle: null,
  }),
  memberAddedForModerators: (
    communityName?: string | null
  ): NotificationCopy => ({
    title: named(communityName),
    body: `A new member joined ${named(communityName)}`,
    inboxTitle: null,
  }),
  adminTransferred: (communityName?: string | null): NotificationCopy => ({
    title: named(communityName),
    body: `You're now the admin of ${named(communityName)}`,
    inboxTitle: null,
  }),
  roleChanged: (
    newRole: string,
    communityName?: string | null
  ): NotificationCopy => ({
    title: named(communityName),
    body: `You're now ${ROLE_LABEL[newRole] ?? newRole.toLowerCase()} in ${named(communityName)}`,
    inboxTitle: null,
  }),
  memberKicked: (communityName?: string | null): NotificationCopy => ({
    title: named(communityName),
    body: `You were removed from ${named(communityName)}`,
    inboxTitle: null,
  }),
  memberBanned: (communityName?: string | null): NotificationCopy => ({
    title: named(communityName),
    body: `You were banned from ${named(communityName)}`,
    inboxTitle: null,
  }),
  memberUnbanned: (communityName?: string | null): NotificationCopy => ({
    title: named(communityName),
    body: `Your ban in ${named(communityName)} has been lifted`,
    inboxTitle: null,
  }),
  memberMuted: (
    mutedUntil?: string | null,
    communityName?: string | null
  ): NotificationCopy => {
    const until = mutedUntil ? formatUntil(mutedUntil) : null;
    return {
      title: named(communityName),
      body: until
        ? `You're muted in ${named(communityName)} until ${until}`
        : `You're muted in ${named(communityName)}`,
      inboxTitle: null,
    };
  },
  memberUnmuted: (communityName?: string | null): NotificationCopy => ({
    title: named(communityName),
    body: `You can post in ${named(communityName)} again`,
    inboxTitle: null,
  }),
  memberWarned: (
    note?: string,
    communityName?: string | null
  ): NotificationCopy => ({
    title: named(communityName),
    body: note?.trim() || `A moderator warned you in ${named(communityName)}`,
    inboxTitle: null,
  }),
  inviteSent: (communityName?: string | null): NotificationCopy => ({
    title: named(communityName),
    body: `You've been invited to join ${named(communityName)}`,
    inboxTitle: null,
  }),
  inviteAccepted: (communityName?: string | null): NotificationCopy => ({
    title: named(communityName),
    body: `Your invite to ${named(communityName)} was accepted`,
    inboxTitle: null,
  }),
  reportCreated: (communityName?: string | null): NotificationCopy => ({
    title: named(communityName),
    body: `A new report in ${named(communityName)} needs review`,
    inboxTitle: null,
  }),
  reportActioned: (communityName?: string | null): NotificationCopy => ({
    title: named(communityName),
    body: `A moderator reviewed your report in ${named(communityName)}`,
    inboxTitle: null,
  }),
  reportResolved: (communityName?: string | null): NotificationCopy => ({
    title: named(communityName),
    body: `Your report in ${named(communityName)} was resolved`,
    inboxTitle: null,
  }),
  deleted: (communityName?: string | null): NotificationCopy => ({
    title: named(communityName),
    body: `${named(communityName)} was deleted`,
    inboxTitle: null,
  }),
  closed: (communityName?: string | null): NotificationCopy => ({
    title: named(communityName),
    body: `${named(communityName)} has been closed`,
    inboxTitle: null,
  }),
  reopened: (communityName: string): NotificationCopy => ({
    title: named(communityName),
    body: `${named(communityName)} is open again`,
    inboxTitle: null,
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
  newLogin: (browser?: string | null, location?: string | null) => {
    const onA = browser ? `a ${browser.toLowerCase()}` : "a new device";
    const body = location
      ? `New login detected on ${onA} from ${location}. If this wasn't you, Terminate Session`
      : `New login detected on ${onA}. If this wasn't you, Terminate Session`;
    return { title: "Login Detected", body } satisfies NotificationCopy;
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
