import amqp from "amqplib";

import { UserEvents, type UserRestoredPayload } from "@aimess/shared-types";

import { env } from "../config/env.js";

const USER_RESTORED_QUEUE = "user.restored.queue";

/**
 * Dead-letter topology for user.restored.queue. Must stay in sync with the
 * user-service consumer; queue arguments are immutable once declared so both
 * sides MUST assert identical deadLetter* args or RabbitMQ throws
 * PRECONDITION_FAILED. Mirrors publish-user-deleted.ts exactly.
 */
const USER_RESTORED_DLX = "user.restored.queue.dlx";
const USER_RESTORED_DLQ_ROUTING_KEY = "user.restored.queue.dead";

let channelPromise: Promise<amqp.Channel> | null = null;

/**
 * Drop the memoized channel so the next publish dials a fresh connection.
 *
 * Same reset the sibling publish-session-revoked.ts performs, and it matters
 * more here: publish-user-deleted.ts gets away without it only because its
 * publish is fire-and-forget. This one is AWAITED and its failure fails the
 * admin's request, so a cached promise resolving to a channel whose socket is
 * already dead would take Re-Activate down for the whole process lifetime —
 * every subsequent restore would throw IllegalOperationError("Channel closed")
 * even after the broker came back.
 */
function resetChannel(current: Promise<amqp.Channel>): void {
  if (channelPromise === current) channelPromise = null;
}

async function getChannel(): Promise<amqp.Channel> {
  if (!channelPromise) {
    const pending = (async () => {
      const connection = await amqp.connect(env.RABBITMQ_URL);
      const channel = await connection.createChannel();
      await channel.assertExchange(USER_RESTORED_DLX, "direct", {
        durable: true,
      });
      await channel.assertQueue(USER_RESTORED_QUEUE, {
        durable: true,
        deadLetterExchange: USER_RESTORED_DLX,
        deadLetterRoutingKey: USER_RESTORED_DLQ_ROUTING_KEY,
      });
      channel.on("close", () => resetChannel(pending));
      channel.on("error", () => resetChannel(pending));
      connection.on("close", () => resetChannel(pending));
      connection.on("error", () => resetChannel(pending));
      return channel;
    })();
    // A failed dial must not be cached either.
    pending.catch(() => resetChannel(pending));
    channelPromise = pending;
  }
  return channelPromise;
}

/**
 * Deliberately NOT a fire-and-forget `…Safe` twin of publishUserDeletedSafe.
 *
 * Deletion may swallow a broker outage because the account is already unusable
 * either way — the auth row is marked and every session is dead, so a lost
 * event degrades to "the profile is still visible", which is recoverable.
 * Restore is the opposite: dropping this event leaves the account able to log
 * in while user-service still reports the profile deleted, i.e. exactly the
 * half-restored state the feature is required to never produce. So the caller
 * awaits it and fails the admin's request instead, and the restore path is
 * idempotent end to end so the admin's retry re-drives this publish.
 */
export async function publishUserRestored(
  data: UserRestoredPayload
): Promise<void> {
  const payload = Buffer.from(
    JSON.stringify({ type: UserEvents.USER_RESTORED, data })
  );

  // One retry on a fresh channel, mirroring publish-session-revoked.ts: the
  // first send after an idle broker restart fails on the stale socket, and the
  // listeners above only reset the memo once that close event lands. The queue
  // is durable, so a message that does land is never lost.
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = channelPromise;
    try {
      const channel = await getChannel();
      channel.sendToQueue(USER_RESTORED_QUEUE, payload, { persistent: true });
      return;
    } catch (error) {
      if (pending) resetChannel(pending);
      channelPromise = null;
      if (attempt === 1) throw error;
    }
  }
}
