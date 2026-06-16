/**
 * Cross-service chat domain events (chat-service → notifications-service).
 * Published to the durable `chat.group.queue`; notifications-service consumes
 * them to push/inbox an added member who is not in the room socket. Mirrors the
 * community MEMBER_ADDED contract.
 */
export const ChatEvents = {
  GROUP_MEMBER_ADDED: "chat.group_member_added",
} as const;

export type ChatEventType = (typeof ChatEvents)[keyof typeof ChatEvents];

export type ChatGroupMemberAddedPayload = {
  roomId: string;
  groupName: string;
  /** The user that was added to the group. */
  addedUserId: string;
  /** Actor (OWNER/ADMIN) who performed the add. */
  actorId: string;
  /** ISO-8601 timestamp captured at emit time. */
  eventAt: string;
};
