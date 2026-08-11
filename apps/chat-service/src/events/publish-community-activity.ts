import { logger } from "@aimess/logger";
import * as amqp from "amqplib";

import { env } from "../config/env.js";

/**
 * Durable queue carrying community chat activity to community-service, which
 * denormalizes it into `Community.lastActivityAt` for inbox-style ordering of
 * `GET /communities/mine`. Publisher (here) and consumer (community-service)
 * MUST assert identical queue args — RabbitMQ queue args are immutable.
 */
const COMMUNITY_ACTIVITY_QUEUE = "community.activity.queue";

export const COMMUNITY_ACTIVITY_EVENT = "community.activity";

export interface CommunityActivityPayload {
  communityId: string;
  /** ISO-8601 timestamp of the latest community message. */
  lastMessageAt: string;
  lastMessageId: string;
  senderUserId?: string;
  senderUsername: string;
  messagePreview: string;
  /**
   * Offline-first list identity for the message behind this activity (see
   * chat-service `lib/list-row-identity.ts`). community-service denormalizes
   * these onto `Community.lastActivity*` so `GET /communities/mine` can hand a
   * client the same identity/freshness the message representations already
   * carry. Omitted for activity with no client-originated message behind it.
   */
  clientMessageId?: string | null;
  seq?: number;
  /** UPPER-CASE canonical content type (TEXT/IMAGE/…/SYSTEM). */
  contentType?: string;
  /** Activity type stored in community-service (e.g. "message", "reaction", "edited"). Defaults to "message". */
  type?: string;
  /**
   * For self-referential SYSTEM lines (a role change or a join), the user the
   * line is ABOUT. community-service stores it as `lastActivityUserId` so the
   * `GET /communities/mine` list can render the personalized `selfPreview`
   * ("You are now a moderator" / "You joined the community") to that one viewer
   * instead of the third-person `messagePreview` everyone else sees.
   */
  subjectUserId?: string;
  /**
   * The first-person ("You …") variant of `messagePreview`, rendered by the SAME
   * deterministic template source as the third-person text (chat-service is the
   * single source of truth — community-service stores this opaque string and
   * never composes its own copy). Only set for self-referential system lines.
   */
  selfPreview?: string;
  /**
   * A SECOND self-referential viewer for the role-change/join family (e.g. a
   * future two-sided lifecycle line). No current caller sets this — reactions
   * used to, but no longer do (see the reaction-overlay fields below).
   */
  targetUserId?: string;
  targetPreview?: string;
  /**
   * Reaction-overlay fields — present ONLY when `type` is `"reaction_added"` /
   * `"reaction_removed"`. A reaction NEVER touches the canonical
   * lastActivityAt/Type/Preview/Username/UserId fields above (those must
   * remain exactly what the rest of the community sees, unaffected by any
   * reaction) — it lives in a fully separate overlay, visible only to its own
   * actor and (if different) the reacted-to message's owner. See
   * community-service's `setReactionActivity`/`clearReactionActivityIfCurrent`.
   */
  reactionMessageId?: string;
  reactionEmoji?: string;
  reactionActorId?: string;
  /** First-person preview shown to the reactor ("You reacted 👍 to 'Hello'"). */
  reactionActorPreview?: string;
  /** The reacted-to message's owner; null for a self-reaction (no second viewer). */
  reactionTargetId?: string | null;
  /** Third-person preview shown to the owner ("Peter reacted ❤️ to '…'"). */
  reactionTargetPreview?: string | null;
}

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(url: string): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(url);
      connection.on("close", () => {
        channelPromise = null;
      });
      connection.on("error", (err: Error) => {
        logger.error("community.activity publisher connection error", err);
      });
      const channel = await connection.createChannel();
      await channel.assertQueue(COMMUNITY_ACTIVITY_QUEUE, { durable: true });
      return channel;
    })();
  }
  return channelPromise;
}

/**
 * Fire-and-forget publish of a community-activity bump. Best-effort: a failure
 * is logged, never thrown, so a message send never fails on its activity event.
 */
export function publishCommunityActivitySafe(
  data: CommunityActivityPayload
): void {
  const url = env.RABBITMQ_URL;
  if (!url) return; // RabbitMQ not configured — skip (matches event consumer guard)
  void (async () => {
    try {
      const channel = await getChannel(url);
      const payload = JSON.stringify({
        type: COMMUNITY_ACTIVITY_EVENT,
        data,
      });
      channel.sendToQueue(COMMUNITY_ACTIVITY_QUEUE, Buffer.from(payload), {
        persistent: true,
      });
    } catch (error) {
      channelPromise = null;
      logger.warn(
        `Failed to publish community.activity for ${data.communityId}: ${String(error)}`
      );
    }
  })();
}
