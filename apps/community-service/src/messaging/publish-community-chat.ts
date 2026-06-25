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

function publishSafe(type: string, data: unknown, label: string): void {
  void (async () => {
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
  })();
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
