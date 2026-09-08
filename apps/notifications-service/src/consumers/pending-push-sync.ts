import { logger } from "@aimess/logger";
import { connectRedis, createSubscriber } from "@aimess/redis";

import { env } from "../config/env.js";
import {
  dropPendingChatMessage,
  updatePendingChatMessage,
} from "../services/chat-push-coalescer.js";

/**
 * Keeps a NOT-YET-SENT notification honest.
 *
 * Coalescing holds a push for a couple of seconds, and a message can be deleted
 * or edited inside that window — "sent by mistake, deleted immediately" is the
 * single most common case. Pushing the original text then would be worse than
 * the burst spam it replaced: the recipient would be notified of a line that no
 * longer exists anywhere in the app.
 *
 * chat-service already broadcasts both facts on the same Redis channels the
 * gateway relays to sockets, so this listens to those rather than asking for a
 * new event: `message:delete` (private/group tombstone),
 * `community:message:deleted`, and the `message:edited` pair. Nothing already
 * DELIVERED is touched — only what is still queued.
 */
export function startPendingPushSync(): void {
  // connectRedis returns a process-wide SINGLETON. psubscribing on it put that
  // shared client into subscriber mode, after which ioredis rejected every
  // ordinary command on it — which killed cacheGetJson/cacheSetJson for the
  // whole service (measured: 114 failures/hour, every notification-settings
  // read and write). Ensure the singleton exists, then take a separate
  // connection for the subscription.
  connectRedis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD,
  });
  const sub = createSubscriber();

  void (async () => {
    if (sub.status === "wait") await sub.connect();
    await sub.psubscribe("conv:*", "community:*");
  })().catch(() => {
    logger.warn("pending-push-sync: subscriber failed to start");
  });
  sub.on("pmessage", (_pattern: string, _channel: string, raw: string) => {
    try {
      const parsed = JSON.parse(raw) as {
        event?: string;
        data?: Record<string, unknown>;
      };
      const event = parsed.event ?? "";
      const data = parsed.data ?? {};
      const messageId = String(data.messageId ?? data.id ?? "");
      if (!messageId) return;

      if (
        event === "message:delete" ||
        event === "message:deleted" ||
        event === "community:message:deleted"
      ) {
        dropPendingChatMessage(messageId);
        return;
      }
      if (event === "message:edited" || event === "community:message:edited") {
        const content = data.content as { text?: unknown } | undefined;
        const text =
          typeof content?.text === "string"
            ? content.text
            : typeof data.contentText === "string"
              ? data.contentText
              : typeof data.message === "string"
                ? data.message
                : "";
        // Only a TEXT edit changes what a notification would say; an edit that
        // carries no text (attachment-only rows) leaves the preview alone.
        if (text) updatePendingChatMessage(messageId, text);
      }
    } catch {
      /* a malformed frame must never take down the consumer */
    }
  });

  logger.info("Pending-push sync listener started");
}
