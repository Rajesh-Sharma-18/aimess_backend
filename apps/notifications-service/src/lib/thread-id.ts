/**
 * Generate stable thread identifiers for notification grouping across iOS, Android, Web.
 * Thread IDs ensure all notifications for the same conversation are grouped together.
 *
 * Rules:
 * - Personal chat: chat_{conversationId}
 * - Group chat: group_{conversationId}
 * - Community chat: community_{communityId}
 * - Other events: event_{type} (only for non-chat notifications that should group)
 *
 * IMPORTANT: Thread IDs must be stable for the lifetime of the conversation.
 * Never generate from senderId, username, displayName, device, or messageId.
 */

export function generateThreadId(
  conversationType: "PERSONAL" | "GROUP" | "COMMUNITY",
  conversationId: string,
  communityId?: string
): string {
  switch (conversationType) {
    case "PERSONAL":
      return `chat_${conversationId}`;
    case "GROUP":
      return `group_${conversationId}`;
    case "COMMUNITY":
      // Use communityId when available; fallback to conversationId
      // (which === communityId in the GeneralRoom schema anyway)
      return `community_${communityId ?? conversationId}`;
    default:
      return `chat_${conversationId}`;
  }
}

/**
 * Generate thread ID for other event types (calls, friend requests, etc.)
 * that should group by their type rather than conversation.
 */
export function generateEventThreadId(eventType: string): string {
  return `event_${eventType}`;
}
