/**
 * One-time backfill: re-publish a `friendship.created` event for every ACCEPTED
 * friendship so chat-service's friendship read-model — which gates private 1-1
 * chat rooms (apps/chat-service/src/events/friendship.consumer.ts) — is populated
 * for friendships that were accepted BEFORE the read-model event path existed.
 *
 * Background: the chat read-model is event-sourced from user-service. The
 * `friendship.created` / `friendship.deleted` events on the `user.events` topic
 * exchange were only added when the publisher/consumer contract was fixed (see
 * src/messaging/publish-friendship.ts). Friendships accepted before that fix were
 * never propagated, so those users hit 403 CHAT_FRIENDSHIP_REQUIRED when opening
 * a private chat. This republishes them through the SAME fixed event path; the
 * chat consumer upserts (and writes both directions), so the backfill is
 * idempotent and safe to re-run.
 *
 *   pnpm --filter @aimess/user-service exec tsx scripts/backfill-chat-friendship-readmodel.ts
 */
import amqp from "amqplib";

import { logger } from "@aimess/logger";
import {
  USER_EVENTS_EXCHANGE,
  FriendshipReadModelEvents,
  type FriendshipReadModelPayload,
} from "@aimess/shared-types";

import { env } from "../src/config/env.js";
import { prisma } from "../src/config/prisma.js";

const BATCH_SIZE = 500;

async function main(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createConfirmChannel();
  // Topic exchange MUST match the live publisher + chat consumer exactly
  // (durable, type "topic") — see src/messaging/publish-friendship.ts.
  await channel.assertExchange(USER_EVENTS_EXCHANGE, "topic", {
    durable: true,
  });

  let cursor: string | undefined;
  let scanned = 0;

  for (;;) {
    const friendships = await prisma.friendship.findMany({
      where: { status: "ACCEPTED" },
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: { id: true, requesterId: true, addresseeId: true },
    });

    if (friendships.length === 0) break;
    cursor = friendships[friendships.length - 1]?.id;

    for (const f of friendships) {
      const body: FriendshipReadModelPayload = {
        type: FriendshipReadModelEvents.FRIENDSHIP_CREATED,
        userA: f.requesterId,
        userB: f.addresseeId,
        status: "ACTIVE",
        timestamp: Date.now(),
      };
      channel.publish(
        USER_EVENTS_EXCHANGE,
        FriendshipReadModelEvents.FRIENDSHIP_CREATED,
        Buffer.from(JSON.stringify(body)),
        { persistent: true }
      );
      scanned += 1;
    }

    // Block until the broker confirms this batch before fetching the next, so a
    // crash never loses already-counted events.
    await channel.waitForConfirms();
    logger.info(
      `Backfill progress: ${String(scanned)} friendship.created published`
    );
  }

  await channel.close();
  await connection.close();
  await prisma.$disconnect();

  logger.info(
    `Backfill done: re-published ${String(scanned)} friendship.created events ` +
      `(chat read-model writes both directions → expect ~${String(scanned * 2)} rows).`
  );
}

main().catch((error: unknown) => {
  logger.error("Chat-friendship read-model backfill failed");
  logger.error(error);
  void prisma.$disconnect();
  process.exitCode = 1;
});
