import { SystemEvent } from "../types/enums.js";
import {
  CHAT_SYSTEM_MESSAGE_BUMPS_ACTIVITY,
  chatSystemMessageBumpsActivity,
} from "@aimess/constants";

/**
 * Whether a SYSTEM event bumps the room's `lastMessageAt`/preview (and
 * therefore its position + preview in the inbox). Shared by Group and Private
 * — both use the same `SystemEvent` enum. Mirrors Community's
 * `SYSTEM_MESSAGE_BUMPS_ACTIVITY` (packages/constants/src/community/system-message.ts):
 * low-signal actions (unpin, invite link created) don't reorder the list;
 * every line members see in a group (join/leave/remove/delete) does.
 */
export const SYSTEM_MESSAGE_BUMPS_ACTIVITY =
  CHAT_SYSTEM_MESSAGE_BUMPS_ACTIVITY as Record<SystemEvent, boolean>;

export function systemMessageBumpsActivity(event: SystemEvent): boolean {
  return chatSystemMessageBumpsActivity(event);
}

// A line that never bumps the room must not become its preview after a delete either.
export const NON_BUMPING_SYSTEM_EVENTS: string[] = Object.entries(
  SYSTEM_MESSAGE_BUMPS_ACTIVITY
)
  .filter(([, bumps]) => !bumps)
  .map(([event]) => event);
