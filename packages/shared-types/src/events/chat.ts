/**
 * Cross-service chat domain events (chat-service → notifications-service).
 * Published to the durable `chat.group.queue`; notifications-service consumes
 * them to push/inbox an added member who is not in the room socket. Mirrors the
 * community MEMBER_ADDED contract.
 */
export const ChatEvents = {
  GROUP_MEMBER_ADDED: "chat.group_member_added",
  /** Leadership handed over (manual or automatic) — pushed to the new leader only. */
  GROUP_LEADER_CHANGED: "chat.group_leader_changed",
  // Private-group join requests. Values double as the notification row `type`
  // (the client contract names them literally).
  GROUP_JOIN_REQUESTED: "GROUP_JOIN_REQUESTED",
  GROUP_JOIN_REQUEST_APPROVED: "GROUP_JOIN_REQUEST_APPROVED",
  GROUP_JOIN_REQUEST_REJECTED: "GROUP_JOIN_REQUEST_REJECTED",
  /** Data-only: deletes the admins' actionable card once the request is settled. */
  GROUP_JOIN_REQUEST_RETRACTED: "GROUP_JOIN_REQUEST_RETRACTED",
} as const;

export type ChatEventType = (typeof ChatEvents)[keyof typeof ChatEvents];

/**
 * Fully-qualified group avatar URL for the push's tray image. Set by the
 * PUBLISHER from the authoritative GroupRoom row (never by the producer), and
 * absent when the group has no avatar — so the client applies its own
 * placeholder rather than rendering a broken attachment.
 */
type GroupPushImage = { groupAvatarUrl?: string };

export type ChatGroupMemberAddedPayload = GroupPushImage & {
  roomId: string;
  groupName: string;
  /** The user that was added to the group. */
  addedUserId: string;
  /** Actor (OWNER/ADMIN) who performed the add. */
  actorId: string;
  /** The actor's group role at the add — an admin/moderator is named by it. */
  actorRole?: string;
  /** ISO-8601 timestamp captured at emit time. */
  eventAt: string;
};

export type ChatGroupLeaderChangedPayload = GroupPushImage & {
  roomId: string;
  groupName: string;
  /** The new leader — the only recipient. */
  targetUserId: string;
  /** Outgoing leader who handed over; "" when automatic. */
  actorId: string;
  auto: boolean;
  eventAt: string;
};

export type ChatGroupJoinRequestedPayload = GroupPushImage & {
  roomId: string;
  groupName: string;
  requestId: string;
  requesterId: string;
  /** ACTIVE ADMINs at emit time — never moderators. */
  adminRecipientIds: string[];
  eventAt: string;
};

export type ChatGroupJoinRequestRetractedPayload = {
  roomId: string;
  groupName?: string;
  requestId: string;
  requesterId: string;
  adminRecipientIds: string[];
  /** APPROVED | REJECTED | CANCELLED | AUTO_RESOLVED | SUPERSEDED */
  resolution: string;
  eventAt: string;
};

export type ChatGroupJoinRequestDecidedPayload = GroupPushImage & {
  roomId: string;
  groupName: string;
  requestId: string;
  requesterId: string;
  decidedBy: string;
  eventAt: string;
};
