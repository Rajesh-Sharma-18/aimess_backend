import type { Channel, ConsumeMessage, ChannelModel } from "amqplib";
import { logger } from "@aimess/logger";
import { CommunitySystemMessageType } from "@aimess/constants";

import { prisma } from "../config/prisma.js";
import { redis } from "../config/redis.js";
import { GeneralRoomRepository } from "../repositories/general-room.repository.js";
import { GeneralRoomMessageRepository } from "../repositories/general-room-message.repository.js";
import { RoomMemberRepository } from "../repositories/room-member.repository.js";
import { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import { PrivateMessageRepository } from "../repositories/private-message.repository.js";
import { CacheRepository } from "../repositories/cache.repository.js";
import { buildParticipantsKey, generateRoomId } from "../lib/room-id.js";
import { CommunitySystemMessageService } from "../services/community-system-message.service.js";
import { UserSnapshotService } from "../services/user-snapshot.service.js";
import { buildChatMessageEvent } from "../lib/chat-message.serializer.js";
import { publishConvUpdatedSafe } from "../events/publish-conv-updated.js";
import { publishMessageSentSafe } from "../events/publish-message-sent.js";

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
    // community.created + community.visibility_changed — community visibility
    communityType?: "PUBLIC" | "PRIVATE";
    // member.synced
    userId?: string;
    status?: string;
    role?: string;
    // member.mute_synced — moderation mute mirror (orthogonal to status/role)
    isMuted?: boolean;
    mutedUntil?: string | null;
    // community.status.changed
    communityStatus?: string;
    // community.invite_link_shared
    communityName?: string;
    linkCode?: string;
    inviterId?: string;
    recipientId?: string;
    eventAt?: string;
    // community.invite_link_shared — additive enrichment (all optional)
    communityAvatarUrl?: string | null;
    memberCount?: number;
    inviteUrl?: string;
    inviteDeepLink?: string;
    isPermanent?: boolean;
    inviterName?: string;
    inviterAvatarUrl?: string | null;
    // community.system_message
    systemMessageType?: string;
    metadata?: Record<string, unknown>;
    triggeredByUserId?: string;
    visibilityType?: "PERSONAL" | "COMMUNITY";
    visibleToUserId?: string;
  };
}

export class CommunityRoomSyncConsumer {
  private channel: Channel | null = null;
  private roomRepo = new GeneralRoomRepository(prisma);
  private memberRepo = new RoomMemberRepository(prisma);
  private messageRepo = new GeneralRoomMessageRepository(prisma);
  private privateRoomRepo = new PrivateRoomRepository(prisma);
  private privateMessageRepo = new PrivateMessageRepository(prisma);
  private communitySystemMessageService = new CommunitySystemMessageService(
    new GeneralRoomMessageRepository(prisma),
    new GeneralRoomRepository(prisma),
    new CacheRepository(redis),
    new UserSnapshotService(),
    redis,
    // Drives the real-time `community:updated` list bump for COMMUNITY-visible
    // system lines (role change, community-info update, joins, …).
    this.memberRepo
  );

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
          // Persist the community visibility on the room so read paths
          // (getMessages/timeline/around/search/sync) can let non-members browse
          // PUBLIC history. Stored on the GeneralRoom — authoritative, no TTL.
          await this.roomRepo.provisionForCommunity(communityId, {
            name: event.data.name ?? "",
            owner: event.data.ownerId ?? null,
            logo: event.data.avatarUrl ?? null,
            communityType: event.data.communityType ?? null,
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

        case "community.visibility_changed": {
          const communityType = event.data.communityType;
          if (communityType === "PUBLIC" || communityType === "PRIVATE") {
            // Persist the new visibility on the room so the read-access guard
            // reflects the policy immediately (PUBLIC→PRIVATE stops leaking
            // history to non-members, and vice-versa).
            await this.roomRepo.setCommunityType(communityId, communityType);
            logger.debug(
              `community.visibility_changed: set type=${communityType} for ${communityId}`
            );
          } else {
            logger.warn(
              `community.visibility_changed: invalid communityType="${String(communityType)}" for ${communityId}`
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

          // Membership-lifecycle cleanup (Telegram parity): when a membership
          // goes INACTIVE (left / removed / banned), hard-delete the user's
          // PERSONAL join-session onboarding lines ("You joined the community",
          // "Your request to join was approved") so they never accumulate across
          // join→leave→rejoin cycles. INTERNAL — no community-wide socket emit.
          // Bounded by the leave-event timestamp so a redelivered stale "left"
          // can't delete a FRESH rejoin line (which is strictly newer).
          //
          // Gate on the RAW event status (LEFT / BANNED), not the mapped
          // `data.status`: mapMemberStatus collapses PENDING (and unknowns) into
          // "left", and a PENDING join-request sync must NOT purge a join line.
          const rawStatus = (event.data.status ?? "").toUpperCase();

          // Mark the member as a fresh join so community:updated bumps are
          // suppressed until community:added arrives at the client. The key
          // expires after 60 s — well past any realistic socket delivery window.
          if (rawStatus === "ACTIVE") {
            await redis
              .set(
                `community:fresh-join:${communityId}:${userId}`,
                "1",
                "EX",
                60
              )
              .catch((err: unknown) => {
                logger.warn(
                  `fresh-join key set failed community=${communityId} user=${userId}: ${String(err)}`
                );
              });
          }

          if (rawStatus === "LEFT" || rawStatus === "BANNED") {
            const boundary = event.data.eventAt
              ? new Date(event.data.eventAt)
              : undefined;
            const deleted = await this.messageRepo
              .deletePersonalJoinMessages({
                roomId: communityId,
                userId,
                beforeOrAt:
                  boundary && !Number.isNaN(boundary.getTime())
                    ? boundary
                    : undefined,
              })
              .catch((err: unknown) => {
                logger.warn(
                  `member.synced join-cleanup failed community=${communityId} user=${userId}: ${String(err)}`
                );
                return 0;
              });
            if (deleted > 0) {
              logger.debug(
                `member.synced join-cleanup: removed ${deleted} personal join line(s) community=${communityId} user=${userId}`
              );
            }
          }
          break;
        }

        case "community.member.mute_synced": {
          // Mirror a moderation mute/unmute onto RoomMember so the community
          // write-path gate (send/edit/react/pin) can block a muted member
          // LOCALLY — no per-message gRPC. Lazy expiry on the read side handles
          // timed mutes; an explicit unmute (manual or auto) clears the flag.
          const userId = event.data.userId;
          if (!userId) break;
          const isMuted = event.data.isMuted === true;
          const mutedUntil =
            isMuted && event.data.mutedUntil
              ? new Date(event.data.mutedUntil)
              : null;
          await this.memberRepo.setMute(communityId, userId, {
            isMuted,
            mutedUntil,
          });
          logger.debug(
            `Synced RoomMember mute community=${communityId} user=${userId} isMuted=${isMuted} until=${mutedUntil?.toISOString() ?? "-"}`
          );
          break;
        }

        case "community.invite_link_shared": {
          const {
            inviterId,
            recipientId,
            linkCode,
            communityId: cId,
            communityName,
            communityAvatarUrl,
            memberCount,
            inviteUrl,
            inviteDeepLink,
            isPermanent,
            inviterName,
            inviterAvatarUrl,
          } = event.data;
          if (!inviterId || !recipientId || !linkCode) {
            logger.warn(
              "community.invite_link_shared: missing inviterId/recipientId/linkCode — skipping"
            );
            break;
          }
          await this.deliverInviteLinkDm({
            inviterId,
            recipientId,
            linkCode,
            communityId: cId,
            communityName: communityName ?? "",
            communityAvatarUrl: communityAvatarUrl ?? null,
            memberCount,
            inviteUrl,
            inviteDeepLink,
            isPermanent,
            inviterName,
            inviterAvatarUrl: inviterAvatarUrl ?? null,
          });
          break;
        }

        case "community.system_message": {
          const {
            systemMessageType,
            metadata,
            triggeredByUserId,
            visibleToUserId,
            eventAt,
          } = event.data;
          if (!systemMessageType || !triggeredByUserId) {
            logger.warn(
              "community.system_message: missing systemMessageType or triggeredByUserId — skipping"
            );
            break;
          }
          const knownTypes = Object.values(CommunitySystemMessageType);
          if (
            !knownTypes.includes(
              systemMessageType as CommunitySystemMessageType
            )
          ) {
            logger.warn(
              `community.system_message: unknown type="${systemMessageType}" — skipping`
            );
            break;
          }
          // Visibility is derived from the central registry inside the service —
          // the publisher no longer dictates it. visibleToUserId is still passed
          // so PERSONAL subtypes know their target.
          await this.communitySystemMessageService.post({
            communityId,
            systemMessageType: systemMessageType as CommunitySystemMessageType,
            metadata: (metadata ?? {}) as Record<string, unknown>,
            triggeredByUserId,
            visibleToUserId,
            // Anchors the idempotency key so a redelivered event can't post a
            // duplicate system line.
            eventAt,
          });
          logger.debug(
            `community.system_message: posted type=${systemMessageType} communityId=${communityId}`
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

  /**
   * Creates or reuses a private room between inviter and recipient, then inserts
   * a SYSTEM message carrying the community invite link and runs the SAME live
   * side-effects as a normal personal message — the canonical `message:new`
   * broadcast, the `conv:updated` inbox bump, the unread + last-activity update,
   * and an FCM/APNs push for offline devices — so the invitation behaves exactly
   * like a personal chat message on every device (web / mobile / desktop).
   *
   * Bypasses the friendship check intentionally — this is an admin-initiated
   * system notification, not a user-to-user message.
   *
   * Idempotent: a deterministic `clientMessageId`
   * (`cinv:<communityId>:<linkCode>:<recipientId>`) means an accidental double
   * Bulk-Send, or a RabbitMQ redelivery, reuses the existing message instead of
   * posting a duplicate invitation.
   */
  private async deliverInviteLinkDm(params: {
    inviterId: string;
    recipientId: string;
    linkCode: string;
    communityId: string;
    communityName: string;
    communityAvatarUrl?: string | null;
    memberCount?: number;
    inviteUrl?: string;
    inviteDeepLink?: string;
    isPermanent?: boolean;
    inviterName?: string;
    inviterAvatarUrl?: string | null;
  }): Promise<void> {
    const {
      inviterId,
      recipientId,
      linkCode,
      communityId,
      communityName,
      communityAvatarUrl = null,
      memberCount,
      inviteUrl,
      inviteDeepLink,
      isPermanent,
      inviterName,
      inviterAvatarUrl = null,
    } = params;

    // 1. Find or create the private room (no friendship check — system event).
    const key = buildParticipantsKey(inviterId, recipientId);
    let room = await this.privateRoomRepo.findByParticipantsKey(key);
    if (!room) {
      const roomId = generateRoomId("prv");
      room = await this.privateRoomRepo.create({
        roomId,
        participants: [inviterId, recipientId].sort(),
        participantsKey: key,
      });
      logger.debug(
        `invite_link_shared: provisioned private room=${roomId} for ${inviterId}↔${recipientId}`
      );
    }

    // 2. Idempotency — a deterministic key per (community, link, recipient) so a
    //    double Bulk-Send or a queue redelivery cannot post a duplicate.
    const clientMessageId = `cinv:${communityId}:${linkCode}:${recipientId}`;
    const existing = await this.privateMessageRepo.findByClientMessageId(
      room.roomId,
      inviterId,
      clientMessageId
    );
    if (existing) {
      logger.debug(
        `invite_link_shared: duplicate suppressed room=${room.roomId} key=${clientMessageId}`
      );
      return;
    }

    // 3. Structured invitation payload — carried in systemData so the client
    //    renders a rich "join community" card. content.text is a human fallback
    //    so the inbox preview + push body are never blank.
    const previewText = communityName
      ? `Invitation to join ${communityName}`
      : "Community invitation";
    const content = { text: previewText };
    const systemData: Record<string, unknown> = {
      communityId,
      communityName,
      communityAvatarUrl,
      memberCount,
      linkCode,
      inviteUrl,
      inviteDeepLink,
      isPermanent,
      inviterId,
      inviterName,
    };

    // 4. Allocate sequence + persist the SYSTEM message. The create is guarded
    //    against the idempotency unique index losing a race (two events in
    //    flight): a duplicate-key error is treated as "already delivered".
    const seq = await this.privateRoomRepo.allocateSequence(room.roomId);
    const message = await this.privateMessageRepo
      .createMessage({
        roomId: room.roomId,
        senderId: inviterId,
        receiverId: recipientId,
        content,
        messageType: "SYSTEM",
        systemEvent: "COMMUNITY_INVITE",
        systemData,
        clientMessageId,
        sequenceNumber: seq,
      })
      .catch((err: unknown) => {
        const sig = `${(err as { code?: string })?.code ?? ""} ${
          (err as Error)?.message ?? ""
        }`;
        if (sig.includes("P2002") || sig.includes("E11000")) {
          logger.debug(
            `invite_link_shared: duplicate create race suppressed room=${room!.roomId} key=${clientMessageId}`
          );
          return null;
        }
        throw err;
      });
    if (!message) return; // duplicate race — already delivered

    const createdAt =
      message.createdAt instanceof Date ? message.createdAt : new Date();
    const sentAt = createdAt.getTime();

    // 5. Unread + last-activity on the PrivateRoom (drives the recipient's inbox
    //    badge + non-blank "Invitation to join …" preview). Fire-and-forget.
    void this.privateRoomRepo
      .updateRoomOnNewMessage({
        roomId: room.roomId,
        message: {
          _id: message.id,
          content,
          senderId: inviterId,
          messageType: "SYSTEM",
          systemEvent: "COMMUNITY_INVITE",
          systemData,
          createdAt,
        },
        receiverId: recipientId,
      })
      .catch((err: unknown) =>
        logger.warn(
          `invite_link_shared: room bump failed room=${room!.roomId}: ${String(err)}`
        )
      );

    // 6. Live broadcast — the canonical message:new wire event (identical shape
    //    to a normal private message; systemEvent/systemData ride along for the
    //    card). Reaches every device joined to the conversation room.
    const wireEvent = buildChatMessageEvent({
      id: message.id,
      clientMessageId,
      roomId: room.roomId,
      conversationType: "PRIVATE",
      senderId: inviterId,
      senderName: inviterName ?? "",
      senderAvatar: "",
      receiverId: recipientId,
      messageType: "SYSTEM",
      content,
      sequenceNumber: seq,
      serverTs: sentAt,
      systemEvent: "COMMUNITY_INVITE",
      systemData,
    });
    await redis
      .publish(
        `conv:${room.roomId}`,
        JSON.stringify({ event: "message:new", data: wireEvent })
      )
      .catch((err: unknown) => {
        logger.warn(
          `invite_link_shared: Redis publish failed for room=${room!.roomId}: ${String(err)}`
        );
      });

    // 7. Inbox bump-to-top + unread fan-out to BOTH participants' devices
    //    (user:<id> channels → multi-device, no refetch).
    publishConvUpdatedSafe({
      redis,
      type: "PRIVATE",
      roomId: room.roomId,
      senderId: inviterId,
      recipientIds: [inviterId, recipientId],
      lastMessageId: message.id,
      lastMessageAt: sentAt,
      preview: { contentType: "SYSTEM", text: previewText },
    });

    // 8. FCM/APNs push for the recipient when offline — reuses the normal chat
    //    push pipeline (notifications-service decides per-device delivery). The
    //    push title is the inviter's name, the body the invitation preview.
    publishMessageSentSafe({
      conversationId: room.roomId,
      conversationType: "PRIVATE",
      messageId: message.id,
      clientMessageId,
      senderId: inviterId,
      senderName: inviterName ?? "",
      senderAvatar: inviterAvatarUrl ?? "",
      preview: previewText,
      messageType: "SYSTEM",
      sentAt,
      recipientIds: [recipientId],
      communityId,
      communityName,
    });

    logger.debug(
      `invite_link_shared: system DM delivered room=${room.roomId} msg=${message.id}`
    );
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
