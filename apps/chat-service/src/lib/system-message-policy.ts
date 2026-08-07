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
 * membership churn (join/left/removed) and low-signal actions (unpin, invite
 * link created) don't reorder the list; content-relevant changes do.
 */
export const SYSTEM_MESSAGE_BUMPS_ACTIVITY =
  CHAT_SYSTEM_MESSAGE_BUMPS_ACTIVITY as Record<SystemEvent, boolean>;

export function systemMessageBumpsActivity(event: SystemEvent): boolean {
  return chatSystemMessageBumpsActivity(event);
}
