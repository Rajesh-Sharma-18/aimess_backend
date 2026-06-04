import type { Channel, ConsumeMessage, ChannelModel } from "amqplib";
import { logger } from "@aimess/logger";

import { prisma } from "../config/prisma.js";
import { GeneralRoomRepository } from "../repositories/general-room.repository.js";
import { RoomMemberRepository } from "../repositories/room-member.repository.js";

/** community member status → chat RoomMember status. */
export function mapMemberStatus(status: string | undefined): string | null {
  if (!status) return null;
  switch (status.toUpperCase()) {
    case "ACTIVE":
      return "active";
    case "BANNED":
      return "banned";
    case "LEFT":
    case "PENDING":
      return "left";
    default:
      return "left";
  }
}

/** community member role → chat RoomMember role. */
export function mapMemberRole(role: string | undefined): string | null {
  if (!role) return null;
  switch (role.toUpperCase()) {
    case "ADMIN":
      return "admin";
    case "MODERATOR":
      return "moderator";
    default:
      return "member";
  }
}

/**
 * Build the `RoomMember` upsert payload from a community member's raw
 * status/role. Shared by the live `community.member.synced` consumer and the
 * boot reconciler so both produce identical rows. Returns null if there's
 * nothing mappable to write.
 */
export function buildRoomMemberSyncData(
  rawStatus: string | undefined,
  rawRole: string | undefined
): Record<string, unknown> | null {
  const status = mapMemberStatus(rawStatus);
  const role = mapMemberRole(rawRole);
  const data: Record<string, unknown> = {};
  if (status) {
    data.status = status;
    // Keep ban/leave bookkeeping consistent with the new status.
    data.bannedAt = status === "banned" ? new Date() : null;
    data.leftAt = status === "left" ? new Date() : null;
  }
  if (role) data.role = role;
  return Object.keys(data).length === 0 ? null : data;
}

/**
 * Consumes community lifecycle events from community-service and keeps a chat
 * room (GeneralRoom, id === communityId) provisioned for each community, so
 * community chat has somewhere to land and a `lastMessageAt` to drive ordering.
 *
 * Plain durable queue (no exchange) — community-service publishes with
 * `sendToQueue`. Queue args MUST match the publisher
 * (community-service `publish-community-chat.ts`).
 */
const QUEUE = "community.chat.sync.queue";

interface CommunityRoomSyncEvent {
  type: string;
  data: {
    communityId: string;
    name?: string;
    avatarUrl?: string | null;
    ownerId?: string | null;
    // member.synced
    userId?: string;
    status?: string;
    role?: string;
    // community.status.changed
    communityStatus?: string;
  };
}

export class CommunityRoomSyncConsumer {
  private channel: Channel | null = null;
  private roomRepo = new GeneralRoomRepository(prisma);
  private memberRepo = new RoomMemberRepository(prisma);

  async start(connection: ChannelModel): Promise<void> {
    this.channel = await connection.createChannel();
    await this.channel.assertQueue(QUEUE, { durable: true });
    await this.channel.consume(QUEUE, (msg) => this.handleMessage(msg));
    logger.info(
      "Community room-sync consumer started (community.chat.sync.queue)"
    );
  }

  private async handleMessage(msg: ConsumeMessage | null): Promise<void> {
    if (!msg) return;

    let event: CommunityRoomSyncEvent;
    try {
      event = JSON.parse(msg.content.toString()) as CommunityRoomSyncEvent;
    } catch (err) {
      logger.error("Discarding malformed community.chat.sync message", err);
      this.channel?.nack(msg, false, false);
      return;
    }

    try {
      const { communityId } = event.data;
      if (!communityId) {
        this.channel?.ack(msg);
        return;
      }

      switch (event.type) {
        case "community.created":
          await this.roomRepo.provisionForCommunity(communityId, {
            name: event.data.name ?? "",
            owner: event.data.ownerId ?? null,
            logo: event.data.avatarUrl ?? null,
          });
          logger.debug(`Provisioned chat room for community ${communityId}`);
          break;

        case "community.deleted":
          await this.roomRepo.deactivateForCommunity(communityId);
          // Members of a deleted community can no longer read its chat history.
          await this.memberRepo.markAllLeft(communityId);
          logger.debug(`Deactivated chat room for community ${communityId}`);
          break;

        case "community.status.changed": {
          const communityStatus = event.data.communityStatus;
          if (communityStatus === "SUSPENDED") {
            await this.roomRepo.suspendForCommunity(communityId);
            logger.debug(`Suspended chat room for community ${communityId}`);
          } else if (communityStatus === "ACTIVE") {
            await this.roomRepo.unsuspendForCommunity(communityId);
            logger.debug(`Unsuspended chat room for community ${communityId}`);
          } else {
            logger.warn(
              `community.status.changed: unknown communityStatus="${String(communityStatus)}" for community ${communityId}`
            );
          }
          break;
        }

        case "community.member.synced": {
          const userId = event.data.userId;
          if (!userId) break;
          const data = buildRoomMemberSyncData(
            event.data.status,
            event.data.role
          );
          if (!data) break;
          // roomId === communityId. upsert handles both first sync and updates;
          // status-only / role-only events touch just those fields.
          await this.memberRepo.upsert(communityId, userId, data);
          logger.debug(
            `Synced RoomMember community=${communityId} user=${userId} status=${String(data.status ?? "-")} role=${String(data.role ?? "-")}`
          );
          break;
        }

        default:
          logger.warn(`Unknown community.chat.sync event type: ${event.type}`);
      }

      this.channel?.ack(msg);
    } catch (err) {
      logger.error("Error processing community.chat.sync event", err);
      this.channel?.nack(msg, false, false);
    }
  }

  async stop(): Promise<void> {
    if (this.channel) {
      try {
        await this.channel.close();
        logger.info("Community room-sync consumer stopped");
      } catch (err) {
        logger.error("Error stopping community room-sync consumer", err);
      }
    }
  }
}
