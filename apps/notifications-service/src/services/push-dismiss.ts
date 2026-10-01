import { logger } from "@aimess/logger";
import { publishUserSocketEvent } from "@aimess/redis";

import { redis } from "../config/redis.js";
import { takeTrayCards } from "../lib/tray-cards.js";
import { pushToUser } from "./push.service.js";

/** Socket event every session of the user gets on /notify. */
export const NOTIFY_DISMISS_EVENT = "notify:dismiss";

export interface DismissInput {
  userId: string;
  /** Tray tags to close (lib/push-tags.ts). */
  tags: string[];
  /** Why, for clients and logs: READ, CLEARED, DELETED, LEFT, REMOVED, FRIEND_RESOLVED… */
  reason: string;
  /**
   * Push `data.type`. `NOTIFICATION_DISMISS` unless a client contract already
   * exists for the case (`MESSAGE_READ` for conversation reads).
   */
  type?: "NOTIFICATION_DISMISS" | "MESSAGE_READ";
  /** Extra string context for the client (conversationId, friendshipId, …). */
  data?: Record<string, string>;
  collapseKey?: string;
  excludeDeviceId?: string;
  /**
   * Send the silent push to Android/iOS even when no card is known to be shown.
   * Only for MESSAGE_READ, which shipped mobile builds already rely on for
   * their own unread state. WEB still only gets it when a card was shown.
   */
  alwaysPushMobile?: boolean;
}

/**
 * Take back tray cards on every device of ONE user — the same user, never
 * anyone else. Two halves:
 *
 *  1. `notify:dismiss` on the user's /notify sockets: every open tab or app
 *     closes the cards it drew and clears the matching unread UI. Always sent.
 *  2. A silent data push `{ op: "cancel", tags }` for the devices that are not
 *     connected: the web worker, a backgrounded or killed app. Only when a card
 *     with one of these tags was actually pushed (tray-cards.ts).
 *
 * Never a visible push, never an inbox row, never gated by settings: a user who
 * has since muted the room must still lose a card they were shown.
 * Best-effort: a dismissal must never fail the action that caused it.
 */
export async function dismissTrayCards(input: DismissInput): Promise<void> {
  const tags = [...new Set(input.tags.filter(Boolean))];
  if (!input.userId || tags.length === 0) return;
  const type = input.type ?? "NOTIFICATION_DISMISS";
  const data: Record<string, string> = {
    ...(input.data ?? {}),
    type,
    op: "cancel",
    tags: tags.join(","),
    reason: input.reason,
  };

  await publishUserSocketEvent(redis, input.userId, NOTIFY_DISMISS_EVENT, {
    ...data,
    tags,
  }).catch((error: unknown) => {
    logger.warn(`[push:dismiss] socket publish failed for ${input.userId}`);
    logger.warn(error);
  });

  const shown = await takeTrayCards(input.userId, tags);
  if (shown.length === 0 && !input.alwaysPushMobile) return;

  await pushToUser({
    userId: input.userId,
    category: "chatEnabled",
    type,
    title: "",
    body: "",
    bypassSettings: true,
    skipInbox: true,
    dataOnly: true,
    priority: "high",
    // As long as the card it closes can sit in a tray.
    ttl: 86_400,
    collapseKey: input.collapseKey ?? `dismiss:${tags[0]}`,
    // Nothing known to be shown: only MESSAGE_READ's mobile contract gets here.
    ...(shown.length === 0
      ? { platforms: ["ANDROID", "IOS"] as ("ANDROID" | "IOS")[] }
      : {}),
    ...(input.excludeDeviceId
      ? { excludeDeviceId: input.excludeDeviceId }
      : {}),
    data,
  }).catch((error: unknown) => {
    logger.warn(`[push:dismiss] push failed for ${input.userId}`);
    logger.warn(error);
  });
}
