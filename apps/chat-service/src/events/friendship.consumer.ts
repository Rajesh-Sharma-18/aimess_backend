import type { Channel, ConsumeMessage, ChannelModel } from "amqplib";
import { logger } from "@aimess/logger";

import { invalidateSendGate } from "../lib/send-gate-cache.js";
import { FriendshipRepository } from "../repositories/friendship.repository.js";
import { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import { PrivateMessageRepository } from "../repositories/private-message.repository.js";
import { CacheRepository } from "../repositories/cache.repository.js";
import { prisma } from "../config/prisma.js";
import { redis } from "../config/redis.js";
import { buildParticipantsKey } from "../lib/room-id.js";
import { PrivateSystemMessageService } from "../services/private-system-message.service.js";
import { ensurePrivateRoom } from "../services/private-room.service.js";
import { UserSnapshotService } from "../services/user-snapshot.service.js";
import { SystemEvent } from "../types/enums.js";
import { buildDeletePayload } from "../lib/chat-message.serializer.js";
import { terminateCallsBetweenSafe } from "./call-terminator.js";
import { notifyRelationshipEnded } from "./call-teardown-bridge.js";

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
  /**
   * `friendship.created` only — this pair had been friends before. Still
   * published by user-service (`Friendship.firstAcceptedAt`); unused here.
   */
  isRefriend?: boolean;
}

export class FriendshipEventConsumer {
  private channel: Channel | null = null;
  private friendshipRepo = new FriendshipRepository();
  private privateRoomRepo = new PrivateRoomRepository(prisma);
  private privateMessageRepo = new PrivateMessageRepository(
    prisma,
    this.privateRoomRepo
  );
  private cacheRepo = new CacheRepository(redis);
  private userSnapshotService = new UserSnapshotService();
  private privateSystemMessageService = new PrivateSystemMessageService(
    this.privateMessageRepo,
    this.privateRoomRepo,
    this.userSnapshotService,
    this.cacheRepo,
    redis
  );

  async start(connection: ChannelModel): Promise<void> {
    try {
      this.channel = await connection.createChannel();

      if (!this.channel) {
        throw new Error("Failed to create channel");
      }

      await this.channel.assertExchange(FRIENDSHIP_EXCHANGE, "topic", {
        durable: true,
      });
      await this.channel.assertQueue(FRIENDSHIP_QUEUE, { durable: true });

      for (const key of ROUTING_KEYS) {
        await this.channel.bindQueue(
          FRIENDSHIP_QUEUE,
          FRIENDSHIP_EXCHANGE,
          key
        );
      }

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

      // Every friendship event moves the "may these two still talk" verdict in
      // one direction or the other, so drop the memo the send path keeps of it
      // rather than waiting out its TTL (see lib/send-gate-cache.ts).
      invalidateSendGate(event.userA);
      invalidateSendGate(event.userB);

      switch (event.type) {
        case "friendship.created":
          await this.friendshipRepo.createFriendship(
            event.userA,
            event.userB,
            event.status || "ACTIVE"
          );
          await this.friendshipRepo.createFriendship(
            event.userB,
            event.userA,
            event.status || "ACTIVE"
          );
          // Pre-create the (silent, unlisted) room; user-service's later getOrCreatePrivateRooms finds it.
          await this.ensureRoom(event.userA, event.userB);
          // Becoming friends is not chat activity: no "now friends" row, no list bump, for any pair.
          // Earlier FRIENDSHIP_CREATED rows are pruned so older builds' bubbles stop resurrecting the chat.
          await this.deleteStaleFriendshipCreatedMessages(
            event.userA,
            event.userB
          );
          await this.repairRoomSnapshot(event);
          logger.debug(`Friendship created: ${event.userA} <-> ${event.userB}`);
          break;

        case "friendship.deleted":
          await this.friendshipRepo.deleteFriendship(event.userA, event.userB);
          await this.friendshipRepo.deleteFriendship(event.userB, event.userA);
          await this.clearBlockedByOnRoom(event.userA, event.userB);
          // Calls are authorized by friendship, so a call that outlives the
          // friendship is a call nobody is authorized to be on. Runs AFTER the
          // replica rows are gone, so the teardown can never race a re-ring.
          await notifyRelationshipEnded(event.userA, event.userB);
          // No system message: "X removed you" / "You removed X" is noise in
          // the conversation, and firing for block's own internal unfriend
          // step also leaked "removed" bubbles into what should be a silent
          // block.
          logger.debug(`Friendship deleted: ${event.userA} <-> ${event.userB}`);
          break;

        case "friendship.blocked":
          await this.friendshipRepo.updateFriendshipStatus(
            event.userA,
            event.userB,
            "BLOCKED"
          );
          await this.addBlockedByToRoom(event.userA, event.userB);
          // A block takes effect NOW, not when the current call happens to
          // end: any ringing or in-progress call between the pair is hung up
          // here. Runs after the read-model write above, so a client that
          // immediately redials hits the (already-updated) block gate.
          //
          // user-service also unfriends as part of a block, but that arrives as
          // a SEPARATE event with its own ordering, so this path ends the call
          // itself rather than relying on the `friendship.deleted` handler above.
          await terminateCallsBetweenSafe(
            event.userA,
            event.userB,
            event.userA
          );
          // No system message: blocking must stay silent to the blocked
          // party (see friendship.service.ts blockUser) — posting a shared
          // chat bubble would tell them "X blocked you" regardless.
          logger.debug(
            `Friendship blocked: ${event.userA} blocked ${event.userB}`
          );
          break;

        case "friendship.banned":
          await this.friendshipRepo.updateFriendshipStatus(
            event.userA,
            event.userB,
            "BANNED"
          );
          await this.postFriendshipSystemMessage(
            event,
            SystemEvent.FRIENDSHIP_BANNED
          );
          logger.debug(
            `Friendship banned: ${event.userA} banned ${event.userB}`
          );
          break;

        default:
          logger.warn(`Unknown friendship event type: ${event.type}`);
      }

      this.channel?.ack(msg);
    } catch (err) {
      logger.error("Error processing friendship event", err);
      this.channel?.nack(msg, false, false);
    }
  }

  /**
   * Best-effort get-or-create of the pair's private room. A failure here must
   * not nack the friendship event — the read-model rows are already written and
   * the room still lazily creates on first open, exactly as before.
   */
  private async ensureRoom(userA: string, userB: string): Promise<void> {
    try {
      await ensurePrivateRoom(
        {
          privateRoomRepo: this.privateRoomRepo,
          userSnapshotService: this.userSnapshotService,
          cacheRepo: this.cacheRepo,
          redis,
        },
        userA,
        userB
      );
    } catch (err) {
      logger.warn(
        `FriendshipEventConsumer|ensureRoom failed ${userA}<->${userB}: ${String(err)}`
      );
    }
  }

  private async postFriendshipSystemMessage(
    event: FriendshipEvent,
    systemEvent: SystemEvent
  ): Promise<void> {
    try {
      const room = await this.privateRoomRepo.findByParticipantsKey(
        buildParticipantsKey(event.userA, event.userB)
      );
      if (!room) return;
      await this.privateSystemMessageService.post({
        roomId: room.roomId,
        actorId: event.userA,
        peerId: event.userB,
        systemEvent,
        systemData: {
          friendshipEventType: event.type,
          friendshipStatus: event.status ?? "",
          eventTs: event.timestamp,
        },
      });
    } catch (err) {
      logger.warn(
        `FriendshipEventConsumer|system message failed type=${event.type}: ${String(err)}`
      );
    }
  }

  /**
   * Re-points the room's preview at its newest surviving message when the prune deleted the one it
   * pointed at; none left clears `lastMessageAt`, which takes the room off the inbox.
   */
  private async repairRoomSnapshot(event: FriendshipEvent): Promise<void> {
    try {
      const room = await this.privateRoomRepo.findByParticipantsKey(
        buildParticipantsKey(event.userA, event.userB)
      );
      if (!room) return;
      const visible = await this.privateMessageRepo.findPreviousVisible(
        room.roomId
      );
      if (visible?.id === room.lastMessageId) return;
      await this.privateRoomRepo.setLastMessage(
        room.roomId,
        visible
          ? {
              id: visible.id,
              senderId: visible.senderId ?? "",
              content: visible.content,
              messageType: visible.messageType,
              createdAt: visible.createdAt,
              clientMessageId: visible.clientMessageId,
              sequenceNumber: visible.sequenceNumber,
              revision: visible.revision,
            }
          : null
      );
    } catch (err) {
      logger.warn(
        `FriendshipEventConsumer|repairRoomSnapshot failed ${event.userA}<->${event.userB}: ${String(err)}`
      );
    }
  }

  private async deleteStaleFriendshipCreatedMessages(
    userA: string,
    userB: string
  ): Promise<void> {
    try {
      const room = await this.privateRoomRepo.findByParticipantsKey(
        buildParticipantsKey(userA, userB)
      );
      if (!room) return;
      const stale = await prisma.privateMessage.findMany({
        where: {
          roomId: room.roomId,
          messageType: "SYSTEM",
          systemEvent: SystemEvent.FRIENDSHIP_CREATED,
          isDeleted: false,
        },
        select: { id: true, sequenceNumber: true },
      });
      for (const msg of stale) {
        const deleted = await this.privateMessageRepo.deleteForEveryone(
          msg.id,
          room.roomId,
          userA
        );
        const tombstone = buildDeletePayload({
          conversationType: "PRIVATE",
          messageId: deleted.id,
          roomId: room.roomId,
          scope: "forEveryone",
          deletedBy: userA,
          sequenceNumber: msg.sequenceNumber,
        });
        await redis
          .publish(
            `conv:${room.roomId}`,
            JSON.stringify({ event: "message:delete", data: tombstone })
          )
          .catch(() => {});
      }
    } catch (err) {
      logger.warn(
        `FriendshipEventConsumer|deleteStaleFriendshipCreatedMessages failed: ${String(err)}`
      );
    }
  }

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
