import { isLiveType } from "./notification-category.js";

const DELETE_ON_ARRIVAL = new Set<string>([
  "friend.cancelled",
  // Group @mention removed (message deleted for everyone, or edited away).
  "chat.mention_retracted",
  // The join request the admin's card announced is no longer PENDING (approved,
  // rejected, cancelled by the requester, or auto-resolved). The card is an
  // action item, so it goes away with the action rather than being rewritten
  // into an outcome nobody needs to read.
  "community.join_request_retracted",
  // The end actor's own "is live" card: they get no ended card (no self-notify),
  // and a live card for a stream that is over must not survive either.
  "community.livestream_retracted",
]);

const LIVESTREAM_STARTED = "community.livestream_started";
const LIVESTREAM_ENDED = "community.livestream_ended";

const FRIEND_TYPES = new Set<string>([
  "friend.requested",
  "friend.accepted",
  "friend.rejected",
  "friend.cancelled",
]);

/**
 * States a friendship card can END a cycle in. A friendship row id is RECYCLED
 * by user-service (`resetToPending` reuses the same `Friendship.id` after
 * REJECTED / CANCELLED / UNFRIENDED), so `friend:<friendshipId>` is stable
 * across cycles — a brand new request would otherwise be swallowed by the
 * resolved card of the PREVIOUS friendship and go out as `notification:updated`
 * instead of `notification:new`. See {@link resolveTransition}.
 */
const RESOLVED_FRIEND_TYPES = new Set<string>([
  "friend.accepted",
  "friend.rejected",
]);

export type NotificationAction = "CREATE" | "UPDATE" | "DELETE" | "NOOP";

export interface TransitionPlan {
  action: NotificationAction;
  resurface: boolean;
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

export function resolveGroupKey(
  type: string,
  actorId: string | undefined,
  data: Record<string, string> = {}
): string | null {
  const explicit = nonEmpty(data.groupKey);
  if (explicit) return explicit;

  // An untyped notification simply has no group — never let a missing type throw
  // and take the whole notification publish down with it.
  if (!nonEmpty(type)) return null;

  if (FRIEND_TYPES.has(type)) {
    const friendshipId = nonEmpty(data.friendshipId);
    if (friendshipId) return `friend:${friendshipId}`;
    const peer =
      nonEmpty(data.requesterId) ??
      nonEmpty(data.addresseeId) ??
      nonEmpty(actorId);
    return peer ? `friend:peer:${peer}` : null;
  }

  if (type === "auth.security_new_login") {
    const sessionId = nonEmpty(data.sessionId);
    return sessionId ? `auth:login:${sessionId}` : null;
  }

  // One card per stream, shared by its start and end events, so the end
  // event transitions the existing start card instead of inserting a
  // duplicate. Keyed by livestreamId (not type) so a later stream in the
  // same community still gets its own card instead of colliding with
  // `community:<id>:<type>` below.
  const livestreamId = nonEmpty(data.livestreamId);
  if (livestreamId && isLiveType(type)) {
    return `livestream:${livestreamId}`;
  }

  const communityId = nonEmpty(data.communityId);
  if (communityId && type.startsWith("community.")) {
    if (type.startsWith("community.join_request")) {
      const subject = nonEmpty(data.requesterId) ?? nonEmpty(actorId) ?? "self";
      return `community:${communityId}:join_request:${subject}`;
    }
    if (type.startsWith("community.invite")) {
      return `community:${communityId}:invite`;
    }
    if (type.startsWith("community.member_")) {
      return `community:${communityId}:membership`;
    }
    if (type.startsWith("community.report")) {
      const reportId = nonEmpty(data.reportId);
      return reportId ? `community:${communityId}:report:${reportId}` : null;
    }
    return `community:${communityId}:${type}`;
  }

  const entityId = nonEmpty(data.entityId) ?? nonEmpty(data.referenceId);
  return entityId ? `${type}:${entityId}` : null;
}

export function resolveTransition(
  existingType: string,
  incomingType: string,
  data: Record<string, string> = {}
): TransitionPlan {
  if (DELETE_ON_ARRIVAL.has(incomingType)) {
    return { action: "DELETE", resurface: false };
  }
  // A start delivered after its end never turns an ended card back into "is live".
  if (existingType === LIVESTREAM_ENDED && incomingType === LIVESTREAM_STARTED) {
    return { action: "NOOP", resurface: false };
  }
  // A NEW request against an already-resolved card is a new friendship cycle on
  // a recycled friendship id — it gets its OWN card (and therefore a real
  // `notification:new`), never an in-place rewrite of the old outcome.
  if (
    incomingType === "friend.requested" &&
    RESOLVED_FRIEND_TYPES.has(existingType)
  ) {
    return { action: "CREATE", resurface: true };
  }
  // Same rule for a community join request, and for the same reason: the join
  // request row is unique per (community, requester) and recycled, so request →
  // cancel → request again arrives with the id — and the group key — of the
  // attempt before it. Rewriting the old card in place is what made a second
  // request produce no `notification:new` and no badge, leaving the admin with
  // a card they had already seen. The producer retracts the previous card
  // first, so in practice there is nothing here to rewrite; this is what keeps
  // that true when a retraction is lost.
  if (incomingType === "community.join_requested") {
    return { action: "CREATE", resurface: true };
  }
  const explicit = nonEmpty(data.resurface);
  if (explicit === "true") return { action: "UPDATE", resurface: true };
  if (explicit === "false") return { action: "UPDATE", resurface: false };
  return { action: "UPDATE", resurface: existingType !== incomingType };
}

export function isTerminalRemoval(incomingType: string): boolean {
  return DELETE_ON_ARRIVAL.has(incomingType);
}
