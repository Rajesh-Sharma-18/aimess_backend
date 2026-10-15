import {
  accountCopy,
  authCopy,
  callCopy,
  communityCopy,
  friendCopy,
  resolutionCopy,
  type CallActivityDirection,
} from "@aimess/constants";

/** Names resolved at read time — fresh snapshot first, then whatever the row stored. */
export interface LegacyNames {
  viewerId: string;
  actorId: string;
  actorName?: string;
  communityName?: string;
}

type Thunk = { descriptor?: { ref: string; args: unknown[] } };
const ticket = (copy: Thunk): string | undefined =>
  copy.descriptor ? JSON.stringify(copy.descriptor) : undefined;

/**
 * AIMESS-72: rows written before replay tickets existed carry only English prose, so they never
 * followed the reader's language. Rebuild the ticket from the row's type + stored ids/names and the
 * names resolved now. A row missing the names its sentence needs returns {} and keeps its stored
 * text — a vaguer translated sentence would be worse than the accurate English one.
 *
 * Authored rows (MESSAGE previews, ANNOUNCEMENT, a moderator's warning note) are never re-rendered.
 */
export function legacyCopyTickets(
  type: string,
  data: Record<string, string>,
  n: LegacyNames
): { copyRef?: string; dataRef?: string } {
  const actor = n.actorName?.trim() || undefined;
  const community = n.communityName?.trim() || data.communityName?.trim() || undefined;
  const c = (build: () => Thunk) => (community ? { copyRef: ticket(build()) } : {});
  const a = (build: () => Thunk) => (actor ? { copyRef: ticket(build()) } : {});

  switch (type) {
    case "friend.requested":
    case "FRIEND_REQUEST_RECEIVED":
      return a(() => friendCopy.requested(actor));
    case "friend.accepted":
    case "FRIEND_REQUEST_ACCEPTED":
      return a(() => friendCopy.acceptedForRequester(actor));
    case "friend.cancelled":
      return a(() => friendCopy.cancelled(actor));
    case "friend.rejected":
      // The requester is told who declined; the addressee keeps their own request card + "declined" line.
      return n.viewerId === data.requesterId
        ? a(() => friendCopy.rejected(actor))
        : actor
          ? {
              copyRef: ticket(friendCopy.requested(actor)),
              dataRef: ticket(resolutionCopy.friendDeclinedSelf()),
            }
          : {};

    case "auth.security_new_login":
      return { copyRef: ticket(authCopy.newLogin(data.deviceName || data.browser, data.location)) };
    case "auth.password_changed":
      return { copyRef: ticket(authCopy.passwordChanged()) };
    case "auth.email_changed":
      return { copyRef: ticket(authCopy.emailChanged()) };
    case "admin.user_banned":
      // Legacy rows stored a reason CODE ("OTHER") and never showed it; keep it out of the sentence.
      return { copyRef: ticket(accountCopy.banned()) };

    case "community.livestream_started":
      return data.hostName ? c(() => communityCopy.livestreamStarted(community!, data.hostName)) : {};
    case "community.livestream_ended": {
      if (!data.hostName) return {};
      const secs = Number(data.durationSeconds);
      return c(() =>
        communityCopy.livestreamEnded(community!, data.hostName, Number.isFinite(secs) ? secs : data.duration)
      );
    }
    case "community.member_joined":
      return c(() => communityCopy.memberJoined(community!));
    case "community.member_added":
      return c(() => communityCopy.memberAdded(community, actor, undefined, n.actorId, n.viewerId));
    case "community.member_kicked":
      return c(() => communityCopy.memberKicked(community, actor, undefined, n.actorId, n.viewerId));
    case "community.member_role_changed":
      return data.newRole
        ? c(() => communityCopy.roleChanged(data.newRole, community, actor, undefined, data.oldRole))
        : {};
    case "community.member_banned":
      return c(() => communityCopy.memberBanned(community, actor));
    case "community.member_unbanned":
      return c(() => communityCopy.memberUnbanned(community, actor));
    case "community.member_muted":
      return c(() => communityCopy.memberMuted(data.mutedUntil || undefined, community, actor));
    case "community.member_warned":
      // The note is moderator-authored and stays verbatim; only the heading is product copy.
      return c(() => communityCopy.memberWarned(data.note, community));
    case "community.member_unmuted":
      return c(() => communityCopy.memberUnmuted(community));
    case "community.admin_transferred":
      return c(() => communityCopy.adminTransferred(community));
    case "community.invite_sent":
      return c(() => communityCopy.inviteSent(community));
    case "community.report_created":
      return c(() => communityCopy.reportCreated(community));
    case "community.report_actioned":
      return c(() => communityCopy.reportActioned(community));
    case "community.deleted":
      return c(() => communityCopy.deleted(community));
    case "community.closed":
      return c(() => communityCopy.closed(community));
    case "community.join_requested":
      return actor ? c(() => communityCopy.joinRequested(community!, actor)) : {};
    case "community.join_request_approved": {
      const by = data.decidedByDisplayName?.trim() || actor;
      return by ? c(() => communityCopy.joinRequestApproved(community!, by)) : {};
    }
    case "community.join_request_rejected":
      return c(() => communityCopy.joinRequestRejected(community!, data.decidedByDisplayName || actor));

    case "CALL_MISSED":
      return data.callerName && data.callType
        ? { copyRef: ticket(callCopy.missed(data.callerName, data.callType)) }
        : {};
    case "call.activity": {
      const peer = data.inboxTitle?.trim() || actor;
      return peer && data.callType && data.callStatus && data.callDirection
        ? {
            copyRef: ticket(
              callCopy.activity(
                peer,
                data.callType,
                data.callStatus,
                data.callDirection as CallActivityDirection,
                Number(data.durationSec) || 0
              )
            ),
          }
        : {};
    }
    default:
      return {};
  }
}
