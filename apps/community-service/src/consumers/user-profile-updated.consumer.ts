import { logger } from "@aimess/logger";
import amqp from "amqplib";
import { publishCommunityRoomEvent } from "@aimess/redis";

import {
  UserEvents,
  type CommunityMemberUpdatedPayload,
  type UserProfileUpdatedPayload,
} from "@aimess/shared-types";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import { communityRepository } from "../repositories/community.repository.js";
import { buildAvatarMedia } from "../lib/build-avatar-media.js";

const EXCHANGE = "user.profile_updated";
const QUEUE = "user.profile_updated.community.queue";
const DLX = "user.profile_updated.community.queue.dlx";
const DLQ = "user.profile_updated.community.queue.dlq";
const DLQ_ROUTING_KEY = "user.profile_updated.community.queue.dead";

const PREFETCH = 10;

export async function startUserProfileUpdatedConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertExchange(EXCHANGE, "fanout", { durable: true });

  await channel.assertExchange(DLX, "direct", { durable: true });
  await channel.assertQueue(DLQ, { durable: true });
  await channel.bindQueue(DLQ, DLX, DLQ_ROUTING_KEY);

  await channel.assertQueue(QUEUE, {
    durable: true,
    deadLetterExchange: DLX,
    deadLetterRoutingKey: DLQ_ROUTING_KEY,
  });
  await channel.bindQueue(QUEUE, EXCHANGE, "");

  await channel.prefetch(PREFETCH);

  logger.info(
    `[user-profile-consumer] Listening on queue=${QUEUE} prefetch=${PREFETCH} — ready to sync community member snapshots`
  );

  channel.consume(QUEUE, async (message) => {
    if (!message) return;

    let parsed: { type: string; data: UserProfileUpdatedPayload };
    try {
      parsed = JSON.parse(message.content.toString()) as {
        type: string;
        data: UserProfileUpdatedPayload;
      };
    } catch (error) {
      logger.error("Discarding malformed user.profile_updated message body");
      logger.error(error);
      channel.nack(message, false, false);
      return;
    }

    try {
      if (parsed.type === UserEvents.USER_PROFILE_UPDATED) {
        const { userId, username, displayName, avatarObjectKey } = parsed.data;

        // Update stored snapshots
        await communityRepository.updateMemberSnapshotsByUserId(userId, {
          snapshotUsername: username,
          snapshotDisplayName: displayName,
          snapshotAvatarKey: avatarObjectKey,
        });

        // Keep the community-list preview sender name in sync too. The
        // `lastActivityUsername` column is denormalized + frozen at message-send
        // time, so a rename otherwise leaves "<old name>: <preview>" stuck on
        // the community list even though the chat room (which renders the live
        // member snapshot refreshed just above) shows the new name.
        await communityRepository.updateLastActivityUsernameByUserId(
          userId,
          displayName
        );

        // Broadcast real-time profile update to all communities the user is in
        void (async () => {
          try {
            const memberships =
              await communityRepository.findUserMemberships(userId);

            if (memberships.length === 0) return;

            // Resolve avatar to presigned URL (if avatar exists)
            const avatarMedia = await buildAvatarMedia(avatarObjectKey);
            const avatarUrl = avatarMedia.downloadUrl;

            // Broadcast member:updated to each community room. Each publish is
            // independently guarded — a single room's Redis failure must not
            // abort the rest of the fan-out (and, un-awaited, would otherwise
            // surface as an unhandled rejection past this IIFE's try/catch).
            for (const membership of memberships) {
              void publishCommunityRoomEvent(
                redis,
                membership.communityId,
                "community:member:updated",
                {
                  communityId: membership.communityId,
                  userId,
                  username,
                  displayName,
                  avatarUrl,
                  role: membership.role,
                  // Wire contract is epoch-ms; the source event carries an ISO
                  // string. Convert (fall back to now on an unparseable value).
                  updatedAt: Number.isNaN(Date.parse(parsed.data.updatedAt))
                    ? Date.now()
                    : Date.parse(parsed.data.updatedAt),
                } satisfies CommunityMemberUpdatedPayload
              ).catch((err: unknown) => {
                logger.warn(
                  `community:member:updated broadcast failed (profile sync) community=${membership.communityId} user=${userId}: ${String(err)}`
                );
              });
            }
          } catch (error) {
            logger.error(
              `Failed to broadcast member update for userId=${parsed.data.userId}`
            );
            logger.error(error);
          }
        })();
      } else {
        logger.warn(
          `Unknown event type on user.profile_updated.queue: ${parsed.type}`
        );
      }

      channel.ack(message);
    } catch (error) {
      logger.error("Failed to process user.profile_updated event");
      logger.error(error);
      channel.nack(message, false, false);
    }
  });
}
