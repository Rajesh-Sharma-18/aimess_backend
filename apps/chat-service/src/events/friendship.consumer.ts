import type { Channel, ConsumeMessage, ChannelModel } from "amqplib";
import { logger } from "@aimess/logger";
import { FriendshipRepository } from "../repositories/friendship.repository.js";
import { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import { prisma } from "../config/prisma.js";
import { buildParticipantsKey } from "../lib/room-id.js";

const FRIENDSHIP_EXCHANGE = "user.events";
const FRIENDSHIP_QUEUE = "chat-service.friendship";
const ROUTING_KEYS = [
  "friendship.created",
  "friendship.deleted",
  "friendship.blocked",
  "friendship.banned",
];

export interface FriendshipEvent {
  type: string;
  userA: string;
  userB: string;
  status?: string;
  timestamp: number;
}

export class FriendshipEventConsumer {
  private channel: Channel | null = null;
  private friendshipRepo = new FriendshipRepository();
  private privateRoomRepo = new PrivateRoomRepository(prisma);

  async start(connection: ChannelModel): Promise<void> {
    try {
      this.channel = await connection.createChannel();

      if (!this.channel) {
        throw new Error("Failed to create channel");
      }

      // Declare exchange and queue
      await this.channel.assertExchange(FRIENDSHIP_EXCHANGE, "topic", {
        durable: true,
      });
      await this.channel.assertQueue(FRIENDSHIP_QUEUE, { durable: true });

      // Bind queue to exchange for each routing key
      for (const key of ROUTING_KEYS) {
        await this.channel.bindQueue(
          FRIENDSHIP_QUEUE,
          FRIENDSHIP_EXCHANGE,
          key
        );
      }

      // Start consuming
      await this.channel.consume(
        FRIENDSHIP_QUEUE,
        (msg: ConsumeMessage | null) => this.handleMessage(msg)
      );

      logger.info("Friendship event consumer started");
    } catch (err) {
      logger.error("Failed to start friendship event consumer", err);
      throw err;
    }
  }

  private async handleMessage(msg: ConsumeMessage | null): Promise<void> {
    if (!msg) return;

    try {
      const event: FriendshipEvent = JSON.parse(msg.content.toString());

      switch (event.type) {
        case "friendship.created":
          await this.friendshipRepo.createFriendship(
            event.userA,
            event.userB,
            event.status || "ACTIVE"
          );
          // Also create the reverse relationship (bidirectional)
          await this.friendshipRepo.createFriendship(
            event.userB,
            event.userA,
            event.status || "ACTIVE"
          );
          logger.debug(`Friendship created: ${event.userA} ↔ ${event.userB}`);
          break;

        case "friendship.deleted":
          await this.friendshipRepo.deleteFriendship(event.userA, event.userB);
          await this.friendshipRepo.deleteFriendship(event.userB, event.userA);
          // Clear blockedBy on the PrivateRoom (unblock path publishes this)
          await this.clearBlockedByOnRoom(event.userA, event.userB);
          logger.debug(`Friendship deleted: ${event.userA} ↔ ${event.userB}`);
          break;

        case "friendship.blocked":
          // When userA blocks userB, we mark it as BLOCKED
          await this.friendshipRepo.updateFriendshipStatus(
            event.userA,
            event.userB,
            "BLOCKED"
          );
          // Also update PrivateRoom.blockedBy so call.service's guard works
          await this.addBlockedByToRoom(event.userA, event.userB);
          logger.debug(
            `Friendship blocked: ${event.userA} blocked ${event.userB}`
          );
          break;

        case "friendship.banned":
          // When userA bans userB, we mark it as BANNED
          await this.friendshipRepo.updateFriendshipStatus(
            event.userA,
            event.userB,
            "BANNED"
          );
          logger.debug(
            `Friendship banned: ${event.userA} banned ${event.userB}`
          );
          break;

        default:
          logger.warn(`Unknown friendship event type: ${event.type}`);
      }

      // Acknowledge the message
      this.channel?.ack(msg);
    } catch (err) {
      logger.error("Error processing friendship event", err);
      // Nack the message (don't requeue to avoid infinite loops)
      this.channel?.nack(msg, false, false);
    }
  }

  // ponytail: best-effort room update — no room = no-op (pair may never have chatted)
  private async addBlockedByToRoom(
    blockerId: string,
    blockedId: string
  ): Promise<void> {
    try {
      const key = buildParticipantsKey(blockerId, blockedId);
      const room = await this.privateRoomRepo.findByParticipantsKey(key);
      if (!room) return;
      const current = Array.isArray(room.blockedBy)
        ? (room.blockedBy as string[])
        : [];
      if (current.includes(blockerId)) return;
      await prisma.privateRoom.update({
        where: { roomId: room.roomId },
        data: { blockedBy: [...current, blockerId] },
      });
    } catch (err) {
      logger.warn("Failed to update PrivateRoom.blockedBy on block", err);
    }
  }

  private async clearBlockedByOnRoom(
    userA: string,
    userB: string
  ): Promise<void> {
    try {
      const key = buildParticipantsKey(userA, userB);
      const room = await this.privateRoomRepo.findByParticipantsKey(key);
      if (!room) return;
      const current = Array.isArray(room.blockedBy)
        ? (room.blockedBy as string[])
        : [];
      const updated = current.filter((id) => id !== userA && id !== userB);
      if (updated.length === current.length) return;
      await prisma.privateRoom.update({
        where: { roomId: room.roomId },
        data: { blockedBy: updated },
      });
    } catch (err) {
      logger.warn("Failed to clear PrivateRoom.blockedBy on delete", err);
    }
  }

  async stop(): Promise<void> {
    if (this.channel) {
      try {
        await this.channel.cancel(FRIENDSHIP_QUEUE);
        await this.channel.close();
        logger.info("Friendship event consumer stopped");
      } catch (err) {
        logger.error("Error stopping friendship consumer", err);
      }
    }
  }
}
