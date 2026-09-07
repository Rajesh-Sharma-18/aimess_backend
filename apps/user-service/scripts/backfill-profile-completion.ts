/**
 * One-time backfill: recompute profile-completion for every UserProfile and
 * re-publish a `user.profile_updated` event so auth-service's mirrored
 * `AuthUser.isProfileCompleted` flag catches up with the current rule
 * (complete ⟺ username + firstName + lastName all present — see
 * packages/utils/src/profile-completion.ts).
 *
 * Why this is needed: auth-service does not own the name fields; it only mirrors
 * the boolean via the event, and the flag is otherwise refreshed only when a
 * user edits their profile. Existing rows therefore keep a stale value until
 * this backfill re-publishes for them.
 *
 * Safe to re-run: the event carries the current derived value and the consumer
 * is idempotent (it just sets the flag), so running it repeatedly is a no-op.
 *
 *   # all profiles
 *   pnpm --filter @aimess/user-service backfill:profile-completion
 *
 *   # one or more specific users (fast for repeated testing of an account)
 *   pnpm --filter @aimess/user-service backfill:profile-completion -- <userId> [userId...]
 */
import amqp from "amqplib";

import { logger } from "@aimess/logger";
import {
  UserEvents,
  type UserProfileUpdatedPayload,
} from "@aimess/shared-types";
import { isProfileComplete } from "@aimess/utils";

import { env } from "../src/config/env.js";
import { prisma } from "../src/config/prisma.js";
import { buildDisplayName } from "../src/lib/profile-fields.util.js";

// Queue topology MUST match the live publisher/consumer exactly — queue args are
// immutable once declared (see src/messaging/publish-profile-updated.ts).
const QUEUE = "user.profile_updated.queue";
const DLX = "user.profile_updated.queue.dlx";
const DLQ_ROUTING_KEY = "user.profile_updated.queue.dead";

const BATCH_SIZE = 200;

// Optional positional args = specific userIds to backfill. Empty = all profiles.
const targetUserIds = process.argv
  .slice(2)
  .filter((arg) => arg.trim().length > 0);

async function main(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createConfirmChannel();
  await channel.assertExchange(DLX, "direct", { durable: true });
  await channel.assertQueue(QUEUE, {
    durable: true,
    deadLetterExchange: DLX,
    deadLetterRoutingKey: DLQ_ROUTING_KEY,
  });

  if (targetUserIds.length > 0) {
    logger.info(
      `Backfill scoped to ${String(targetUserIds.length)} user(s): ${targetUserIds.join(", ")}`
    );
  }

  let cursor: string | undefined;
  let scanned = 0;
  let completed = 0;

  for (;;) {
    const profiles = await prisma.userProfile.findMany({
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { userId: cursor } } : {}),
      ...(targetUserIds.length > 0
        ? { where: { userId: { in: targetUserIds } } }
        : {}),
      orderBy: { userId: "asc" },
      select: {
        userId: true,
        username: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        updatedAt: true,
      },
    });

    if (profiles.length === 0) break;
    cursor = profiles[profiles.length - 1]?.userId;

    for (const profile of profiles) {
      const isProfileCompleted = isProfileComplete(profile);
      const payload: UserProfileUpdatedPayload = {
        userId: profile.userId,
        username: profile.username,
        displayName: buildDisplayName(profile.firstName, profile.lastName),
        avatarObjectKey: profile.avatarUrl ?? null,
        isProfileCompleted,
        updatedAt: profile.updatedAt.toISOString(),
      };

      channel.sendToQueue(
        QUEUE,
        Buffer.from(
          JSON.stringify({
            type: UserEvents.USER_PROFILE_UPDATED,
            data: payload,
          })
        ),
        { persistent: true }
      );

      scanned += 1;
      if (isProfileCompleted) completed += 1;
    }

    // Block until the broker confirms this batch before fetching the next one,
    // so a crash never loses already-counted events.
    await channel.waitForConfirms();
    logger.info(
      `Backfill progress: ${String(scanned)} scanned, ${String(completed)} complete`
    );
  }

  await channel.close();
  await connection.close();
  await prisma.$disconnect();

  logger.info(
    `Backfill done: re-published ${String(scanned)} profile_updated events ` +
      `(${String(completed)} complete, ${String(scanned - completed)} incomplete).`
  );
}

main().catch((error: unknown) => {
  logger.error("Profile-completion backfill failed");
  logger.error(error);
  void prisma.$disconnect();
  process.exitCode = 1;
});
