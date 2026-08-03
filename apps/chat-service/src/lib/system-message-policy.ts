import { SystemEvent } from "../types/enums.js";

/**
 * Whether a SYSTEM event bumps the room's `lastMessageAt`/preview (and
 * therefore its position + preview in the inbox). Shared by Group and Private
 * — both use the same `SystemEvent` enum. Mirrors Community's
 * `SYSTEM_MESSAGE_BUMPS_ACTIVITY` (packages/constants/src/community/system-message.ts):
 * membership churn (join/left/removed) and low-signal actions (unpin, invite
 * link created) don't reorder the list; content-relevant changes do.
 */
export const SYSTEM_MESSAGE_BUMPS_ACTIVITY: Record<SystemEvent, boolean> = {
  GROUP_CREATED: true,
  MEMBER_JOINED: false,
  MEMBER_LEFT: false,
  MEMBER_REMOVED: false,
  MEMBER_ADDED: true,
  MEMBER_BANNED: false,
  MEMBER_UNBANNED: false,
  OWNERSHIP_TRANSFERRED: true,
  ROOM_RENAMED: true,
  ROLE_CHANGED: true,
  AVATAR_CHANGED: true,
  ADMIN_ASSIGNED: true,
  ADMIN_REMOVED: true,
  DESCRIPTION_CHANGED: true,
  INVITE_LINK_CREATED: false,
  GROUP_INVITE: true,
  CALL_STARTED: true,
  CALL_ENDED: true,
  MESSAGE_PINNED: true,
  MESSAGE_UNPINNED: false,
  MESSAGES_ENCRYPTED: false,
};

export function systemMessageBumpsActivity(event: SystemEvent): boolean {
  return SYSTEM_MESSAGE_BUMPS_ACTIVITY[event] ?? true;
}
