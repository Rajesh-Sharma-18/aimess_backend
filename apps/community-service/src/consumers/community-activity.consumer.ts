import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { env } from "../config/env.js";
import { communityRepository } from "../repositories/community.repository.js";

/**
 * Consumes chat-service's community-activity events and bumps
 * `Community.lastActivityAt` (forward-only), so `GET /communities/mine` can
 * order communities by their latest message.
 *
 * Queue args MUST match the publisher (chat-service
 * `publish-community-activity.ts`): a plain durable queue, no DLX — RabbitMQ
 * queue args are immutable, so a mismatch yields PRECONDITION_FAILED.
 */
const QUEUE = "community.activity.queue";
const ACTIVITY_EVENT = "community.activity";
const PREFETCH = 10;

interface CommunityActivityMessage {
  type: string;
  data: {
    communityId: string;
    lastMessageAt: string;
    lastMessageId: string;
    senderUserId?: string;
    senderUsername?: string;
    messagePreview?: string;
    type?: string;
    /** First-person ("You …") preview for a self-referential SYSTEM line
     *  (role change / join) — reactions no longer use this field. */
    selfPreview?: string;
    /** Offline-first list identity of the message behind this activity — see
     *  chat-service `publish-community-activity.ts`. */
    clientMessageId?: string | null;
    seq?: number;
    contentType?: string;
    /** Second self-referential viewer (role change / join target) — reactions
     *  no longer use this field. */
    targetUserId?: string;
    targetPreview?: string;
    /**
     * Reaction-overlay fields, present only when `type` is "reaction_added" /
     * "reaction_removed". A reaction NEVER goes through the canonical
     * lastActivity* bump above — it is a fully separate overlay, visible only
     * to its own actor + the reacted-to message's owner (see
     * community.repository.ts's setReactionActivity/clearReactionActivityIfCurrent).
     */
    reactionMessageId?: string;
    reactionEmoji?: string;
    reactionActorId?: string;
    reactionActorPreview?: string;
    reactionTargetId?: string | null;
    reactionTargetPreview?: string | null;
  };
}

const REACTION_ADDED = "reaction_added";
const REACTION_REMOVED = "reaction_removed";

export async function startCommunityActivityConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertQueue(QUEUE, { durable: true });
  await channel.prefetch(PREFETCH);

  logger.info(
    "Community-service consumer listening on community.activity.queue"
  );

  void channel.consume(QUEUE, (message) => {
    if (!message) return;

    void (async () => {
      let parsed: CommunityActivityMessage;
      try {
        parsed = JSON.parse(
          message.content.toString()
        ) as CommunityActivityMessage;
      } catch (error) {
        logger.error("Discarding malformed community.activity message body");
        logger.error(error);
        channel.nack(message, false, false);
        return;
      }

      try {
        if (parsed.type === ACTIVITY_EVENT) {
          const { communityId } = parsed.data;
          if (parsed.data.type === REACTION_ADDED) {
            if (
              communityId &&
              parsed.data.reactionMessageId &&
              parsed.data.reactionEmoji &&
              parsed.data.reactionActorId
            ) {
              await communityRepository.setReactionActivity(communityId, {
                messageId: parsed.data.reactionMessageId,
                emoji: parsed.data.reactionEmoji,
                actorId: parsed.data.reactionActorId,
                actorPreview: parsed.data.reactionActorPreview ?? "",
                targetId: parsed.data.reactionTargetId ?? null,
                targetPreview: parsed.data.reactionTargetPreview ?? null,
                reactedAt: new Date(parsed.data.lastMessageAt),
              });
            }
          } else if (parsed.data.type === REACTION_REMOVED) {
            if (
              communityId &&
              parsed.data.reactionMessageId &&
              parsed.data.reactionEmoji &&
              parsed.data.reactionActorId
            ) {
              await communityRepository.clearReactionActivityIfCurrent(
                communityId,
                {
                  messageId: parsed.data.reactionMessageId,
                  emoji: parsed.data.reactionEmoji,
                  actorId: parsed.data.reactionActorId,
                }
              );
            }
          } else {
            const at = new Date(parsed.data.lastMessageAt);
            if (communityId && !Number.isNaN(at.getTime())) {
              const updatedCount = await communityRepository.updateLastActivity(
                communityId,
                at,
                parsed.data.type ?? "message",
                parsed.data.messagePreview ?? "",
                parsed.data.senderUsername ?? null,
                parsed.data.senderUserId ?? null,
                parsed.data.selfPreview ?? null,
                parsed.data.targetUserId ?? null,
                parsed.data.targetPreview ?? null,
                {
                  messageId: parsed.data.lastMessageId ?? null,
                  clientMessageId: parsed.data.clientMessageId ?? null,
                  seq: parsed.data.seq ?? 0,
                  contentType: parsed.data.contentType ?? null,
                }
              );
              logger.info(
                `[LIVE-SIDEBAR:COMMUNITY] community.activity updateLastActivity communityId=${communityId} activityType=${parsed.data.type ?? "message"} at=${at.toISOString()} updatedCount=${updatedCount} preview="${parsed.data.messagePreview ?? ""}"`
              );
            }
          }
        } else {
          logger.warn(
            `Unknown event type on community.activity.queue: ${parsed.type}`
          );
        }
        channel.ack(message);
      } catch (error) {
        // Best-effort denormalization: drop on failure (the next message will
        // re-bump). No DLQ for this queue.
        logger.error("Failed to process community.activity event");
        logger.error(error);
        channel.nack(message, false, false);
      }
    })();
  });
}
