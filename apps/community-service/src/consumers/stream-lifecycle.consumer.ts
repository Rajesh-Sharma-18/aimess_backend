import { logger } from "@aimess/logger";
import {
  CommunitySystemMessageType,
  formatStreamDuration,
} from "@aimess/constants";
import amqp from "amqplib";

import { env } from "../config/env.js";
import { redis } from "../config/redis.js";
import { communityRepository } from "../repositories/community.repository.js";
import { communityImageService } from "../services/community-image.service.js";
import { memberAvatarService } from "../services/member-avatar.service.js";
import { publishCommunitySystemMessageForChatSafe } from "../messaging/publish-community-chat.js";
import {
  publishCommunityLivestreamStartedSafe,
  publishCommunityLivestreamEndedSafe,
} from "../messaging/publish-community.js";

/**
 * Turns the raw stream-service livestream lifecycle events (`stream.started` /
 * `stream.ended` on the topic exchange `aimess.events`) into community-level
 * effects:
 *   1. a chat SYSTEM message ("{host} started a livestream" /
 *      "{host} ended the livestream (1h 24m)", or "System ended the livestream
 *      (1h 24m)" when the platform ended it) — which also bumps the community
 *      list preview, and
 *   2. a recipient-resolved push fan-out event for notifications-service.
 *
 * The realtime live banner is emitted directly by stream-service
 * (`community:stream:started` / `:ended`); this consumer owns only the chat +
 * push side-effects. Exchange/queue args MUST match the producer (topic, durable)
 * or RabbitMQ yields PRECONDITION_FAILED.
 */
const EXCHANGE = "aimess.events";
const QUEUE = "community.stream-lifecycle.queue";
const STREAM_STARTED = "stream.started";
const STREAM_ENDED = "stream.ended";
const PREFETCH = 10;
/** TTL on the per-stream push-dedup key — long enough to absorb redeliveries. */
const NOTIFY_DEDUP_TTL_SEC = 6 * 60 * 60;

interface StreamStartedData {
  streamId: string;
  communityId: string;
  creatorId: string;
  /** epoch ms */
  livedAt?: number;
}
interface StreamEndedData {
  streamId: string;
  communityId: string;
  creatorId: string;
  /** epoch ms */
  endedAt?: number;
  durationSeconds?: number;
  /**
   * Raw end reason from stream-service's finalizeAsEnded: "HOST_ENDED" for the
   * host's own End Live (and the natural ends that default to it), otherwise an
   * admin reason code (POLICY_VIOLATION, MANUAL_ADMIN, …) or a moderation /
   * account reason. Absent on the PENDING-timeout sweeper's event.
   */
  reason?: string;
  /** The user who ended it: the host, or the community admin on COMMUNITY_ADMIN_ENDED. */
  endedBy?: string | null;
  /** A Super Admin ended it from Backoffice (adminForceEnd). */
  byPlatformAdmin?: boolean;
}

/**
 * Coarsen the raw reason to who ended the stream — the same split
 * stream-service's audit row makes: USER when a community member did it (the
 * host's End Live, a community admin's End for Everyone), ADMIN for a Super
 * Admin's Backoffice End Live ("An administrator"), SYSTEM for the platform
 * (moderation, bans, timeouts). The raw reason never reaches clients: a
 * moderation code would leak why.
 */
export function streamEndedReason(
  reason?: string,
  byPlatformAdmin?: boolean
): "USER" | "ADMIN" | "SYSTEM" {
  if (byPlatformAdmin) return "ADMIN";
  return !reason || reason === "HOST_ENDED" || reason === "COMMUNITY_ADMIN_ENDED"
    ? "USER"
    : "SYSTEM";
}

/**
 * Who the "{actor} ended the livestream" line names: the community admin who
 * forced the end, otherwise the host.
 */
export function streamEndedActorId(data: StreamEndedData): string {
  return data.reason === "COMMUNITY_ADMIN_ENDED" && data.endedBy
    ? data.endedBy
    : data.creatorId;
}

/** Active members eligible for the push (minus `excludeUserId`, minus stream-muted). */
async function resolveRecipients(
  communityId: string,
  excludeUserId: string | null
): Promise<string[]> {
  const [memberIds, mutedIds] = await Promise.all([
    communityRepository.findActiveMemberIds(communityId),
    communityRepository.findStreamMutedMemberIds(communityId),
  ]);
  const muted = new Set(mutedIds);
  return memberIds.filter((id) => id !== excludeUserId && !muted.has(id));
}

/** Resolve the host's display-name + avatar URL from the community member snapshot. */
async function resolveHost(
  communityId: string,
  hostUserId: string
): Promise<{ displayName: string; avatarUrl: string | null }> {
  const member = await communityRepository.findMemberByUserId(
    communityId,
    hostUserId
  );
  if (!member) return { displayName: "", avatarUrl: null };
  const avatar = await memberAvatarService.resolveViewUrl(
    member.snapshotAvatarKey
  );
  return {
    displayName: member.snapshotDisplayName ?? "",
    avatarUrl: avatar?.url ?? null,
  };
}

/**
 * Claim the one-time push slot for (streamId, phase). false ⇒ a prior delivery
 * already fanned out — skip to avoid a duplicate push on RabbitMQ redelivery. The
 * chat SYSTEM message has its own (eventAt-based) idempotency and is always sent.
 */
async function claimNotify(streamId: string, phase: string): Promise<boolean> {
  try {
    const res = await redis.set(
      `community:livestream:notified:${streamId}:${phase}`,
      "1",
      "EX",
      NOTIFY_DEDUP_TTL_SEC,
      "NX"
    );
    return res === "OK";
  } catch {
    return true; // Redis hiccup: don't suppress the notification.
  }
}

export async function handleStreamStarted(
  data: StreamStartedData
): Promise<void> {
  const { communityId, streamId, creatorId } = data;
  if (!communityId || !streamId || !creatorId) return;
  const eventAt = new Date(data.livedAt || Date.now()).toISOString();
  logger.info(
    `[LIVE-SIDEBAR:COMMUNITY] stream.started lifecycle received communityId=${communityId} streamId=${streamId} creatorId=${creatorId} eventAt=${eventAt}`
  );

  // 1. Host-named chat SYSTEM message. Idempotent via the eventAt-derived dedup
  //    key; chat-service resolves the host name from triggeredByUserId and bumps
  //    the community list (LIVE_STREAM_STARTED bumps activity).
  publishCommunitySystemMessageForChatSafe({
    communityId,
    systemMessageType: CommunitySystemMessageType.LIVE_STREAM_STARTED,
    metadata: { livestreamId: streamId },
    triggeredByUserId: creatorId,
    eventAt,
  });
  logger.info(
    `[LIVE-SIDEBAR:COMMUNITY] LIVE_STREAM_STARTED system message queued communityId=${communityId} streamId=${streamId} eventAt=${eventAt}`
  );

  // 2. Push fan-out (deduped against RabbitMQ redelivery).
  if (!(await claimNotify(streamId, "started"))) {
    logger.info(
      `[LIVE-SIDEBAR:COMMUNITY] stream.started notification deduped communityId=${communityId} streamId=${streamId}`
    );
    return;
  }
  const community = await communityRepository.findById(communityId);
  if (!community) {
    logger.warn(
      `[LIVE-SIDEBAR:COMMUNITY] stream.started community not found communityId=${communityId} streamId=${streamId}`
    );
    return;
  }
  const [recipientIds, host, communityAvatarView] = await Promise.all([
    resolveRecipients(communityId, creatorId),
    resolveHost(communityId, creatorId),
    communityImageService.resolveViewUrlForClient(community.avatarUrl),
  ]);
  logger.info(
    `[LIVE-SIDEBAR:COMMUNITY] stream.started recipients resolved communityId=${communityId} streamId=${streamId} recipients=${recipientIds.length}`
  );
  if (recipientIds.length === 0) return;

  publishCommunityLivestreamStartedSafe({
    communityId,
    eventAt,
    livestreamId: streamId,
    hostUserId: creatorId,
    hostDisplayName: host.displayName,
    hostAvatarUrl: host.avatarUrl,
    communityName: community.name,
    communityHandle: community.handle,
    communityAvatarUrl: communityAvatarView?.url ?? null,
    recipientIds,
  });
}

export async function handleStreamEnded(data: StreamEndedData): Promise<void> {
  const { communityId, streamId, creatorId } = data;
  if (!communityId || !streamId || !creatorId) return;
  const eventAt = new Date(data.endedAt || Date.now()).toISOString();
  const durationSeconds = Math.max(0, Math.floor(data.durationSeconds ?? 0));
  const duration = formatStreamDuration(durationSeconds);
  const endedReason = streamEndedReason(data.reason, data.byPlatformAdmin);
  logger.info(
    `[LIVE-SIDEBAR:COMMUNITY] stream.ended lifecycle received communityId=${communityId} streamId=${streamId} creatorId=${creatorId} eventAt=${eventAt} durationSeconds=${durationSeconds} reason=${data.reason ?? ""} endedReason=${endedReason}`
  );

  // 1. Chat SYSTEM message: "{actor} ended the livestream (1h 24m)", where the
  //    actor is the host or, on a community admin's End for Everyone, that
  //    admin; "An administrator ended …" for ADMIN (Super Admin, Backoffice),
  //    "System ended …" for SYSTEM. Both keep the host as the triggering user.
  const actorId = streamEndedActorId(data);
  publishCommunitySystemMessageForChatSafe({
    communityId,
    systemMessageType: CommunitySystemMessageType.LIVE_STREAM_ENDED,
    metadata: {
      livestreamId: streamId,
      duration,
      durationSeconds,
      endedReason,
      hostUserId: creatorId,
    },
    triggeredByUserId: actorId,
    eventAt,
  });
  logger.info(
    `[LIVE-SIDEBAR:COMMUNITY] LIVE_STREAM_ENDED system message queued communityId=${communityId} streamId=${streamId} eventAt=${eventAt}`
  );

  // 2. Push fan-out.
  if (!(await claimNotify(streamId, "ended"))) {
    logger.info(
      `[LIVE-SIDEBAR:COMMUNITY] stream.ended notification deduped communityId=${communityId} streamId=${streamId}`
    );
    return;
  }
  const community = await communityRepository.findById(communityId);
  if (!community) {
    logger.warn(
      `[LIVE-SIDEBAR:COMMUNITY] stream.ended community not found communityId=${communityId} streamId=${streamId}`
    );
    return;
  }
  // Nobody is pushed about their own End Live: the host on their own end, the
  // community admin on End for Everyone (the host IS told). A Super Admin is not
  // a member, so the host is told too. A SYSTEM end keeps the host out, as before.
  const pushExcluded =
    endedReason === "ADMIN" ? null : endedReason === "SYSTEM" ? creatorId : actorId;
  const [recipientIds, host, actor, communityAvatarView] = await Promise.all([
    resolveRecipients(communityId, pushExcluded),
    resolveHost(communityId, creatorId),
    actorId !== creatorId ? resolveHost(communityId, actorId) : null,
    communityImageService.resolveViewUrlForClient(community.avatarUrl),
  ]);
  logger.info(
    `[LIVE-SIDEBAR:COMMUNITY] stream.ended recipients resolved communityId=${communityId} streamId=${streamId} recipients=${recipientIds.length}`
  );
  if (recipientIds.length === 0) return;

  publishCommunityLivestreamEndedSafe({
    communityId,
    eventAt,
    livestreamId: streamId,
    hostUserId: creatorId,
    hostDisplayName: host.displayName,
    hostAvatarUrl: host.avatarUrl,
    communityName: community.name,
    communityHandle: community.handle,
    communityAvatarUrl: communityAvatarView?.url ?? null,
    duration,
    durationSeconds,
    endedReason,
    ...(actor
      ? { endedByUserId: actorId, endedByDisplayName: actor.displayName }
      : {}),
    recipientIds,
  });
}

export async function startStreamLifecycleConsumer(): Promise<void> {
  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();
  await channel.assertExchange(EXCHANGE, "topic", { durable: true });
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.bindQueue(QUEUE, EXCHANGE, STREAM_STARTED);
  await channel.bindQueue(QUEUE, EXCHANGE, STREAM_ENDED);
  await channel.prefetch(PREFETCH);

  logger.info(
    "Community-service consumer listening on community.stream-lifecycle.queue"
  );

  void channel.consume(QUEUE, (message) => {
    if (!message) return;
    void (async () => {
      let parsed: { type?: string; data?: unknown };
      try {
        parsed = JSON.parse(message.content.toString()) as {
          type?: string;
          data?: unknown;
        };
      } catch (error) {
        logger.error("Discarding malformed stream lifecycle message body");
        logger.error(error);
        channel.nack(message, false, false);
        return;
      }
      try {
        if (parsed.type === STREAM_STARTED) {
          await handleStreamStarted(parsed.data as StreamStartedData);
        } else if (parsed.type === STREAM_ENDED) {
          await handleStreamEnded(parsed.data as StreamEndedData);
        } else {
          logger.warn(
            `Unknown event on community.stream-lifecycle.queue: ${parsed.type}`
          );
        }
        channel.ack(message);
      } catch (error) {
        // Best-effort: drop (no requeue). The next lifecycle event re-bumps the
        // list and the realtime banner is owned by stream-service.
        logger.error("Failed to process stream lifecycle event");
        logger.error(error);
        channel.nack(message, false, false);
      }
    })();
  });
}
