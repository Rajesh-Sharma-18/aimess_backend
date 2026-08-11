import type { Channel, ConsumeMessage, ChannelModel } from "amqplib";
import { logger } from "@aimess/logger";
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
   * published by user-service (`Friendship.firstAcceptedAt`), but no longer
   * gates the "now friends" row: prior conversation activity does.
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
          // The room usually does NOT exist yet at this point: user-service
          // publishes this event and only then (fire-and-forget) asks us over
          // gRPC to create the room, so we lose that race and the "now friends"
          // system message below silently found no room to post into. Create it
          // here instead — the ACTIVE rows we just wrote are exactly what the
          // friendship gate would check, and user-service's later
          // getOrCreatePrivateRooms call now just finds this room.
          await this.ensureRoom(event.userA, event.userB);
          // The "now friends" row separates a NEW chapter from an existing
          // conversation — with nothing above it, it is just noise. So the
          // gate is whether this pair ever exchanged anything, NOT whether
          // they were friends before (`event.isRefriend`, now unused here):
          // a pair that unfriends and re-friends without ever having talked
          // still opens on the clean "no conversation yet" screen.
          if (await this.hasConversationActivity(event.userA, event.userB)) {
            // An unfriend->re-friend cycle would otherwise stack a fresh
            // bubble on top of every earlier one — remove any prior
            // FRIENDSHIP_CREATED system messages in this room first so only
            // the latest ever shows. Skipped when nothing will be posted, so
            // a stray event cannot silently delete a legitimate row.
            await this.deleteStaleFriendshipCreatedMessages(
              event.userA,
              event.userB
            );
            await this.postFriendshipSystemMessage(
              event,
              SystemEvent.FRIENDSHIP_CREATED
            );
          } else {
            await this.stampRoomActivity(event);
          }
          logger.debug(`Friendship created: ${event.userA} <-> ${event.userB}`);
          break;

        case "friendship.deleted":
          await this.friendshipRepo.deleteFriendship(event.userA, event.userB);
          await this.friendshipRepo.deleteFriendship(event.userB, event.userA);
          await this.clearBlockedByOnRoom(event.userA, event.userB);
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
   * Has this pair ever had conversation activity — any message, media, sticker
   * or call row — in their private room?
   *
   * Source of truth is `PrivateRoom.lastSequence`, the per-room insert counter
   * (`allocateSequence`). It is bumped once per timeline row written and is
   * never decremented, so it survives delete-for-me, clear conversation,
   * delete-for-everyone and the auto-delete sweeper — all of which can leave a
   * room with zero *visible* messages after a real conversation. Counting rows
   * or reading `lastMessage`/`lastMessageAt` would answer "is anything visible
   * now", which is the wrong question; `lastMessageAt` in particular is also
   * stamped on an empty room by `stampRoomActivity` below.
   *
   * ponytail: a SYSTEM row (auto-delete setting changed, friendship banned) in
   * an otherwise silent room also bumps the counter and reads as activity. Add
   * a write-once `firstActivityAt` stamped only by user sends if that matters.
   */
  private async hasConversationActivity(
    userA: string,
    userB: string
  ): Promise<boolean> {
    try {
      const room = await this.privateRoomRepo.findByParticipantsKey(
        buildParticipantsKey(userA, userB)
      );
      return (room?.lastSequence ?? 0) > 0;
    } catch (err) {
      // Unknown => treat as a fresh pair: a missing row is cheaper than a
      // stray "now friends" bubble at the top of an empty chat.
      logger.warn(
        `FriendshipEventConsumer|hasConversationActivity failed ${userA}<->${userB}: ${String(err)}`
      );
      return false;
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
   * Put a brand-new, message-less room on both inboxes.
   *
   * `GET /chat/inbox` keysets on `lastMessageAt` and skips NULL rows, so before
   * this the "now friends" system message was what made an accepted friendship
   * appear in the conversation list at all. Friendships with no prior
   * conversation post no message, so the room needs its own timestamp — the new
   * friend's chat vanished from the list on reload until someone said
   * something. Preview stays empty: there is no message, only an opened
   * conversation. Never overwrites a room that already has activity.
   */
  private async stampRoomActivity(event: FriendshipEvent): Promise<void> {
    try {
      const room = await this.privateRoomRepo.findByParticipantsKey(
        buildParticipantsKey(event.userA, event.userB)
      );
      if (!room || room.lastMessageAt) return;
      await prisma.privateRoom.update({
        where: { roomId: room.roomId },
        data: { lastMessageAt: new Date(event.timestamp || Date.now()) },
      });
    } catch (err) {
      logger.warn(
        `FriendshipEventConsumer|stampRoomActivity failed ${event.userA}<->${event.userB}: ${String(err)}`
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
