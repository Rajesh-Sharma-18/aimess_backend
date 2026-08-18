/**
 * Cross-service chat domain events (chat-service → notifications-service).
 * Published to the durable `chat.group.queue`; notifications-service consumes
 * them to push/inbox an added member who is not in the room socket. Mirrors the
 * community MEMBER_ADDED contract.
 */
export const ChatEvents = {
  GROUP_MEMBER_ADDED: "chat.group_member_added",
  /**
   * Moderation mute / unmute on a group member — the group counterpart of
   * community's MEMBER_MUTED / MEMBER_UNMUTED. Notified to the TARGET only:
   * the socket fan-out (`group:member:muted`) covers live clients, this covers
   * a member whose devices were offline when the mute landed.
   */
  GROUP_MEMBER_MUTED: "chat.group_member_muted",
  GROUP_MEMBER_UNMUTED: "chat.group_member_unmuted",
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
  /** ISO-8601 timestamp captured at emit time. */
  eventAt: string;
};

export type ChatGroupMemberMutedPayload = GroupPushImage & {
  roomId: string;
  groupName: string;
  /** The member who was muted/unmuted — the only recipient of this event. */
  targetUserId: string;
  /** Admin/moderator who acted; "" for an automatic mute expiry. */
  actorId: string;
  /** ISO-8601 expiry of a timed mute; null = indefinite (or unmute). */
  mutedUntil: string | null;
  /** ISO-8601 timestamp captured at emit time. */
  eventAt: string;
};
