import { logger } from "@aimess/logger";

import { redis } from "../config/redis.js";
import { pushToUser } from "./push.service.js";

/**
 * Retracting an ALREADY-DELIVERED chat push.
 *
 * The coalescer can only cancel what it still holds (see `dropPendingChatMessage`);
 * once a push has left, the tray entry lives on the device and outlives the
 * message it describes. "Sent by mistake, deleted for everyone" therefore left a
 * card that navigates to a tombstone — the notification half of the delete.
 *
 * So the flush records WHO it pushed for each message, and a delete-for-everyone
 * sends those recipients a data-only `MESSAGE_DELETED` push: the same mechanical,
 * settings-bypassing shape the read-dismiss push (`MESSAGE_READ`, read.consumer.ts)
 * already uses to clear a tray entry on another device.
 *
 * What each client does with it:
 *  - **Web** — `public/firebase-messaging-sw.js` closes the matching tray
 *    notification (`registration.getNotifications()` + `close()`), the same way
 *    it already closes a ring on `CALL_CANCELLED`.
 *  - **Android** — the app owns chat rendering (every chat push is data-only
 *    there), so it holds the notification id and can cancel it. Needs the
 *    client-side handler; until that ships the card stays.
 *  - **iOS** — removable with `removeDeliveredNotifications(withIdentifiers:)`
 *    from the background wake. Same story: needs the client-side handler.
 *
 * Best-effort throughout, exactly like the push it retracts: a Redis blip or a
 * dead token must never make a delete fail.
 */

/** Recipient set per message. 24h = the default FCM TTL, after which the push
 *  is undeliverable and the tray entry is the user's own history anyway. */
const PUSHED_TTL_SEC = 86_400;

/** `{messageId}` hash tag keeps the key on one cluster slot. */
const pushedKey = (messageId: string): string => `push:msg:{${messageId}}`;

/**
 * Remember that `userId` was pushed for these messages. Called once per flush
 * with every message the coalesced notification stood for, because any ONE of
 * them being deleted retracts the card that represents them all.
 */
export async function recordPushedMessages(
  userId: string,
  messageIds: readonly string[]
): Promise<void> {
  const ids = [...new Set(messageIds)].filter(Boolean);
  if (!userId || ids.length === 0) return;
  try {
    const pipeline = redis.pipeline();
    for (const id of ids) {
      pipeline.sadd(pushedKey(id), userId);
      pipeline.expire(pushedKey(id), PUSHED_TTL_SEC);
    }
    await pipeline.exec();
  } catch (error) {
    logger.warn(
      `[push:retract] failed to record recipients for ${ids.length} message(s)`
    );
    logger.warn(error);
  }
}

/**
 * A message was deleted for everyone — tell the devices that were pushed for it
 * to drop the tray entry.
 *
 * Idempotent by construction: the recipient set is claimed with a DEL before
 * anything is sent, so a redelivered delete event (or the same event reaching
 * several replicas) retracts exactly once and a second pass finds nothing to do.
 * Sending twice would be harmless anyway — closing a notification that is
 * already gone is a no-op on every platform.
 */
export async function retractMessagePush(
  messageId: string,
  conversationId: string
): Promise<void> {
  if (!messageId) return;
  let userIds: string[] = [];
  try {
    const key = pushedKey(messageId);
    userIds = await redis.smembers(key);
    if (userIds.length === 0) return;
    await redis.del(key);
  } catch (error) {
    logger.warn(`[push:retract] recipient lookup failed for ${messageId}`);
    logger.warn(error);
    return;
  }

  const results = await Promise.allSettled(
    userIds.map((userId) =>
      pushToUser({
        userId,
        category: "chatEnabled",
        type: "MESSAGE_DELETED",
        title: "",
        body: "",
        // A retraction, not a notification: a recipient who has since muted the
        // room (or turned Chat off) must still lose the card they were shown.
        bypassSettings: true,
        skipInbox: true,
        dataOnly: true,
        priority: "high",
        // As long as the push it retracts (the FCM default), not the 5 minutes a
        // read-dismiss gets: the tray card survives the browser being closed, so
        // the retraction has to survive being queued for just as long or a device
        // that comes back an hour later keeps a card for a deleted message.
        ttl: 86_400,
        // Per MESSAGE, never per conversation: two deletes in a row must not
        // collapse into one, or the second card would never be retracted.
        collapseKey: `del:${messageId}`,
        data: {
          type: "MESSAGE_DELETED",
          messageId,
          ...(conversationId ? { conversationId } : {}),
        },
      })
    )
  );

  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed > 0) {
    logger.warn(
      `[push:retract] ${failed}/${userIds.length} retraction push(es) failed for message ${messageId}`
    );
  }
}
