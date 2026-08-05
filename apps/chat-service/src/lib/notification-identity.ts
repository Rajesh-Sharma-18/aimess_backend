const DELETE_ON_ARRIVAL = new Set<string>(["friend.cancelled"]);

const FRIEND_TYPES = new Set<string>([
  "friend.requested",
  "friend.accepted",
  "friend.rejected",
  "friend.cancelled",
]);

export type NotificationAction = "CREATE" | "UPDATE" | "DELETE";

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
  const explicit = nonEmpty(data.resurface);
  if (explicit === "true") return { action: "UPDATE", resurface: true };
  if (explicit === "false") return { action: "UPDATE", resurface: false };
  return { action: "UPDATE", resurface: existingType !== incomingType };
}

export function isTerminalRemoval(incomingType: string): boolean {
  return DELETE_ON_ARRIVAL.has(incomingType);
}
