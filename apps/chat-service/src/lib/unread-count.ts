/**
 * SINGLE SOURCE OF TRUTH for whether a message counts toward unread
 * badges/counters, across Private, Group, and Community chats.
 *
 * Policy: only genuine user-generated messages count toward unread. A
 * message is a SYSTEM message — and therefore excluded — if `messageType`
 * is `"SYSTEM"`, or if it carries a `systemEvent` (private/group) or
 * `systemMessageType` (community) marker at all, regardless of subtype.
 * There is no "important system message" exception: no system message,
 * however significant (member added, role changed, community created,
 * pinned, livestream start/end, etc.), inflates an unread count. System
 * messages remain fully visible in chat history — this flag only governs
 * unread accounting.
 *
 * `explicit` lets a caller override the derived value for a specific
 * persisted row (e.g. a client-provided `countInUnread` on a normal
 * message); it always wins.
 */
export function shouldCountInUnread(params: {
  messageType?: string | null;
  systemEvent?: string | null;
  systemMessageType?: string | null;
  explicit?: boolean | null;
}): boolean {
  if (typeof params.explicit === "boolean") return params.explicit;

  const messageType = String(params.messageType ?? "").toUpperCase();

  // `systemEvent` / `systemMessageType` are authoritative on their own — a row
  // can carry a lifecycle marker while using a NON-"SYSTEM" kind (call rows are
  // stored as VOICE_CALL / VIDEO_CALL so the client can render a call card, yet
  // are still audit lines that must not raise a badge). Checking messageType
  // first and returning early would have counted every one of them.
  const isSystemMessage =
    messageType === "SYSTEM" ||
    !!params.systemEvent ||
    !!params.systemMessageType;

  return !isSystemMessage;
}

export const UNREAD_COUNTABLE_RAW_MATCH = {
  $or: [
    { countInUnread: { $ne: false } },
    { countInUnread: { $exists: false } },
  ],
} as const;
