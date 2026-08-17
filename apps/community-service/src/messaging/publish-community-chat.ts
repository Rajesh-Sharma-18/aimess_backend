import { logger } from "@aimess/logger";
import amqp from "amqplib";

import { env } from "../config/env.js";

/**
 * Dedicated queue that drives chat-service's provisioning of a chat room per
 * community (GeneralRoom, id === communityId). Separate from `community.queue`
 * (consumed by notifications-service) so both services get every event — a
 * single queue would split messages between competing consumers.
 *
 * Queue args MUST match chat-service's consumer (`community-room-sync.consumer`).
 */
const QUEUE = "community.chat.sync.queue";

let channelPromise: Promise<amqp.Channel> | null = null;

async function getChannel(): Promise<amqp.Channel> {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(env.RABBITMQ_URL);
      connection.on("close", () => {
        channelPromise = null;
      });
      connection.on("error", (err: Error) => {
        logger.error("community.chat.sync publisher connection error", err);
      });
      const channel = await connection.createChannel();
      await channel.assertQueue(QUEUE, { durable: true });
      return channel;
    })();
  }
  return channelPromise;
}

async function publishRaw(
  type: string,
  data: unknown,
  label: string
): Promise<void> {
  try {
    const channel = await getChannel();
    channel.sendToQueue(QUEUE, Buffer.from(JSON.stringify({ type, data })), {
      persistent: true,
    });
  } catch (error) {
    channelPromise = null;
    logger.error(`Failed to publish ${label}`);
    logger.error(error);
  }
}

function publishSafe(type: string, data: unknown, label: string): void {
  void publishRaw(type, data, label);
}

export interface CommunityCreatedForChat {
  communityId: string;
  name: string;
  avatarUrl: string | null;
  ownerId: string;
  /** PUBLIC or PRIVATE — used to determine if non-members can read chat history. */
  communityType: "PUBLIC" | "PRIVATE";
}

/** Tells chat-service to provision the community's chat room. */
export function publishCommunityCreatedForChatSafe(
  data: CommunityCreatedForChat
): void {
  publishSafe("community.created", data, "community.created (chat-sync)");
}

/** Tells chat-service to deactivate the community's chat room. */
export function publishCommunityDeletedForChatSafe(communityId: string): void {
  publishSafe(
    "community.deleted",
    { communityId },
    "community.deleted (chat-sync)"
  );
}

export interface CommunityMemberSyncedForChat {
  communityId: string;
  userId: string;
  /** community member status (ACTIVE | LEFT | BANNED | …); omit if unchanged. */
  status?: string;
  /** community member role (ADMIN | MODERATOR | MEMBER); omit if unchanged. */
  role?: string;
  /**
   * ISO timestamp of the membership change. Stamped automatically by the
   * publisher. chat-service uses it as the upper bound for the join-line cleanup
   * on leave/remove/ban, so a redelivered stale event can't purge a fresher
   * rejoin line.
   */
  eventAt?: string;
}

/**
 * Mirrors a community membership change into chat-service's RoomMember so
 * community members can read community chat history. Emitted from the repository
 * mutation methods (createMember/createManyMembers/updateMemberStatus/
 * updateMemberRole) — the single funnel all service branches (join, add, leave,
 * kick, ban, unban, role change, admin handover) pass through, so RoomMember
 * can't drift no matter which service path ran.
 */
export function publishCommunityMemberSyncedForChatSafe(
  data: CommunityMemberSyncedForChat
): void {
  publishSafe(
    "community.member.synced",
    // Stamp eventAt once here so every emit site (createMember / updateMemberStatus
    // / updateMemberRole funnel) carries the membership-change time without
    // duplicating it at each call. chat-service bounds its join-line cleanup by it.
    { ...data, eventAt: data.eventAt ?? new Date().toISOString() },
    "community.member.synced (chat-sync)"
  );
}

export interface CommunityMemberMuteSyncedForChat {
  communityId: string;
  userId: string;
  /** True while the member is moderation-muted; false on unmute/expiry. */
  isMuted: boolean;
  /**
   * ISO timestamp when a timed mute expires; null = indefinite mute (when
   * `isMuted`) or no mute (when `!isMuted`). chat-service mirrors this onto its
   * RoomMember and applies lazy local expiry on the write path.
   */
  mutedUntil: string | null;
}

/**
 * Mirrors a moderation MUTE/UNMUTE into chat-service's RoomMember so the chat
 * write-path can block a muted member WITHOUT a per-message gRPC round-trip
 * (matches how membership status is mirrored via `community.member.synced`).
 * Moderation mute lives in its OWN table (`CommunityMemberMute`) — orthogonal to
 * membership status/role — so it rides a dedicated sync event rather than
 * overloading `community.member.synced`.
 */
export function publishCommunityMemberMuteSyncedForChatSafe(
  data: CommunityMemberMuteSyncedForChat
): void {
  publishSafe(
    "community.member.mute_synced",
    data,
    "community.member.mute_synced (chat-sync)"
  );
}

export interface CommunityStatusChangedForChat {
  communityId: string;
  /** "SUSPENDED" = admin closed; "ACTIVE" = admin reopened. */
  communityStatus: "ACTIVE" | "SUSPENDED";
}

/**
 * Tells chat-service to suspend or unsuspend the community's chat room.
 * The room's `status` field is updated to "suspended" / "active" so that
 * sendMessage checks at the service layer can block new messages while the
 * community is closed without adding any synchronous inter-service coupling
 * to the hot send path.
 */
export function publishCommunityStatusChangedForChatSafe(
  data: CommunityStatusChangedForChat
): void {
  publishSafe(
    "community.status.changed",
    data,
    "community.status.changed (chat-sync)"
  );
}

export interface CommunityInviteLinkSharedForChat {
  communityId: string;
  communityName: string;
  linkCode: string;
  inviterId: string;
  recipientId: string;
  eventAt: string;
  // ── Additive enrichment (all optional → an in-flight event published by an
  //    older build still processes; chat-service degrades each field gracefully).
  //    Lets chat-service render a rich invitation card + a non-blank inbox
  //    preview + an FCM push without any extra cross-service lookup. ───────────
  /** Raw community avatar object key (resolve-on-read; NEVER a presigned URL). */
  communityAvatarUrl?: string | null;
  /** Member-count snapshot at send time, for the invitation card. */
  memberCount?: number;
  /** Community handle — lets chat-service route Join Now to /community/@handle. */
  communityHandle?: string;
  /** Fully-built shareable URL (e.g. https://aimess.me/+CODE or a PUBLIC handle URL). */
  inviteUrl?: string;
  /** App deep link (aimess://join?code=CODE or aimess://resolve?handle=…). */
  inviteDeepLink?: string;
  /** True when the link never expires and has unlimited uses. */
  isPermanent?: boolean;
  /** Inviter display name — chat bubble sender + push title ("John invited you…"). */
  inviterName?: string;
  /** Inviter avatar object key (resolve-on-read) for the push sender avatar. */
  inviterAvatarUrl?: string | null;
}

/**
 * Tells chat-service to deliver a system DM containing the invite link to one
 * recipient. Called once per userId from the bulk-send endpoint.
 * Routed to `community.chat.sync.queue` so chat-service handles it directly.
 */
export function publishCommunityInviteLinkSharedForChatSafe(
  data: CommunityInviteLinkSharedForChat
): void {
  publishSafe(
    "community.invite_link_shared",
    data,
    "community.invite_link_shared (chat-sync)"
  );
}

export interface CommunityNameChangedForChat {
  communityId: string;
  name: string;
}

/**
 * Tells chat-service that a community was renamed, so it can refresh the
 * denormalized `GeneralRoom.name` mirror that titles community chat-message
 * push notifications. Without this, pushes keep showing the OLD name.
 */
export function publishCommunityNameChangedForChatSafe(
  data: CommunityNameChangedForChat
): void {
  publishSafe(
    "community.name_changed",
    data,
    "community.name_changed (chat-sync)"
  );
}

export interface CommunitySystemMessageForChat {
  communityId: string;
  systemMessageType: string;
  metadata: Record<string, unknown>;
  triggeredByUserId: string;
  eventAt: string;
  /** PERSONAL messages are visible only to visibleToUserId; COMMUNITY messages are visible to all. */
  visibilityType?: "PERSONAL" | "COMMUNITY";
  /** For PERSONAL messages, the userId who should see this message. */
  visibleToUserId?: string;
}

export interface CommunityVisibilityChangedForChat {
  communityId: string;
  communityType: "PUBLIC" | "PRIVATE";
}

/**
 * Tells chat-service that a community's visibility (PUBLIC/PRIVATE) changed, so
 * it can refresh the cached community type that drives non-member read access.
 */
export function publishCommunityVisibilityChangedForChatSafe(
  data: CommunityVisibilityChangedForChat
): void {
  publishSafe(
    "community.visibility_changed",
    data,
    "community.visibility_changed (chat-sync)"
  );
}

/**
 * Tells chat-service to post a lifecycle system message in the community's
 * general room. Fire-and-forget.
 */
export function publishCommunitySystemMessageForChatSafe(
  data: CommunitySystemMessageForChat
): void {
  publishSafe(
    "community.system_message",
    data,
    "community.system_message (chat-sync)"
  );
}

/**
 * Same as `publishCommunitySystemMessageForChatSafe`, but awaited — for the
 * one caller (ban) that needs the enqueue to land BEFORE it fires the
 * client-facing eviction/ban-notice events, narrowing the race where the
 * near-instant `community:membership:restricted` Redis publish otherwise
 * reaches the banned user before their MEMBER_BANNED system message (queued
 * here, consumed async by chat-service) does. Still never throws — a publish
 * failure is logged and swallowed, exactly like the fire-and-forget variant.
 */
export async function publishCommunitySystemMessageForChatAwaited(
  data: CommunitySystemMessageForChat
): Promise<void> {
  await publishRaw(
    "community.system_message",
    data,
    "community.system_message (chat-sync)"
  );
}

/**
 * Tells chat-service to find and delete the PERSONAL MEMBER_MUTED system
 * message for `userId` in the community's general room, then emit a
 * `community:message:deleted` socket event to the affected member so the
 * mute banner disappears from their chat UI in real time. Fire-and-forget.
 */
export function publishCommunityMemberMuteRetractedForChatSafe(data: {
  communityId: string;
  userId: string;
}): void {
  publishSafe(
    "community.member.mute_msg_retracted",
    data,
    "community.member.mute_msg_retracted (chat-sync)"
  );
}
