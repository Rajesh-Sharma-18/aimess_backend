import { isHiddenSystemMessage } from "@aimess/constants";

const BACKGROUND_SYSTEM_EVENTS = new Set([
  "INVITE_LINK_CREATED",
  "MESSAGE_UNPINNED",
  "MESSAGES_ENCRYPTED",
  "REACTION_ADDED",
  "REACTION_REMOVED",
  "READ_RECEIPT",
  "TYPING",
  "PRESENCE",
  "MUTE_EXPIRED",
  "SILENT_METADATA_UPDATED",
  "INTERNAL_SYNC",
]);

const BACKGROUND_COMMUNITY_SYSTEM_TYPES = new Set([
  "COMMUNITY_INVITE_CREATED",
  "UNPINNED_MESSAGE",
  "MEMBER_MUTED",
  "MEMBER_UNMUTED",
]);

export function shouldCountInUnread(params: {
  messageType?: string | null;
  systemEvent?: string | null;
  systemMessageType?: string | null;
  explicit?: boolean | null;
}): boolean {
  if (typeof params.explicit === "boolean") return params.explicit;

  const messageType = String(params.messageType ?? "").toUpperCase();
  if (messageType && messageType !== "SYSTEM") return true;

  const systemEvent = params.systemEvent
    ? String(params.systemEvent).toUpperCase()
    : "";
  if (systemEvent) return !BACKGROUND_SYSTEM_EVENTS.has(systemEvent);

  const systemMessageType = params.systemMessageType
    ? String(params.systemMessageType).toUpperCase()
    : "";
  if (systemMessageType) {
    if (isHiddenSystemMessage(systemMessageType)) return false;
    return !BACKGROUND_COMMUNITY_SYSTEM_TYPES.has(systemMessageType);
  }

  return true;
}

export const UNREAD_COUNTABLE_RAW_MATCH = {
  $or: [
    { countInUnread: { $ne: false } },
    { countInUnread: { $exists: false } },
  ],
} as const;
