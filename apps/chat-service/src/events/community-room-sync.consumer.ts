import type { Channel, ConsumeMessage, ChannelModel } from "amqplib";
import { logger } from "@aimess/logger";
import {
  CommunitySystemMessageType,
  PERSONAL_JOIN_SESSION_TYPES,
  inviteContentType,
} from "@aimess/constants";

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
import {
  buildChatMessageEvent,
  buildDeletePayload,
  buildCommunityInvitationAction,
  buildInvitationContent,
} from "../lib/chat-message.serializer.js";
import { publishConvUpdatedSafe } from "../events/publish-conv-updated.js";
import { publishMessageSentSafe } from "../events/publish-message-sent.js";
import { notifyUnreadChanged } from "../events/unread-summary-bridge.js";

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

/**
 * Community member role → chat RoomMember role. Fails CLOSED on anything
 * unrecognized (missing, malformed, or a future enum value this mapper
 * hasn't been taught yet) by returning null so the caller leaves the
 * existing RoomMember.role untouched rather than silently demoting it —
 * only an exact ADMIN/MODERATOR/MEMBER match may write a role.
 */
export function mapMemberRole(role: string | undefined): string | null {
  if (!role) return null;
  switch (role.toUpperCase()) {
    case "ADMIN":
      return "admin";
    case "MODERATOR":
      return "moderator";
    case "MEMBER":
      return "member";
    default:
      return null;
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
    // Becoming ACTIVE always starts a FRESH membership cycle, and community-service
    // deletes the previous cycle's mute row as part of that same transition — so the
    // mirrored write-gate flags must not survive it. Doing it here (rather than
    // relying solely on the `community.member.mute_synced` that accompanies a
    // rejoin) makes the clear self-healing: a dropped or out-of-order stale
    // `{isMuted:true}` can't leave a rejoined member silently unable to send.
    //
    // Safe because status ACTIVE is only ever published on member CREATE and on
    // REJOIN (see community.repository createMember/createManyMembers/
    // reactivateMemberWithSnapshot/reactivateAdminMember) — muting an already-active
    // member rides `mute_synced`, and a role change publishes role WITHOUT status,
    // so neither path reaches this branch and neither can be clobbered.
    if (status === "active") {
      data.isMuted = false;
      data.mutedUntil = null;
    }
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
    communityHandle?: string;
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
  private privateMessageRepo = new PrivateMessageRepository(
    prisma,
    this.privateRoomRepo
  );
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

        case "community.meta_synced": {
          // Rename / avatar change. GeneralRoom.name + .logo are the source
          // every community PUSH title and tray image read (see
          // `conversationHeader` in publish-message-sent.ts), so they must
          // follow the community row or every future push keeps the old pair.
          await this.roomRepo.setCommunityMeta(communityId, {
            ...(event.data.name !== undefined ? { name: event.data.name } : {}),
            ...(event.data.avatarUrl !== undefined
              ? { logo: event.data.avatarUrl }
              : {}),
          });
          logger.debug(
            `community.meta_synced: room metadata refreshed for ${communityId}`
          );
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

          // A status flip changes what the Community nav badge sums: the total
          // comes from findActiveByUser, which counts ACTIVE rows only, so a ban /
          // leave / removal silently subtracts that room's unread and a rejoin
          // adds it back. Nothing else recomputes the badge, so without this it
          // kept the pre-transition total until the user's next mark-read or
          // reconnect. Coalesced per user downstream; fire-and-forget.
          if (data.status) notifyUnreadChanged(userId);

          // Membership-lifecycle cleanup (Telegram parity): when a membership
          // goes INACTIVE (left / removed / banned), hard-delete the user's
          // PERSONAL join-session onboarding lines ("You joined the community",
          // "Your request to join was approved") so they never accumulate across
          // join→leave→rejoin cycles. No community-wide socket emit (other
          // members never saw this PERSONAL line), but the affected user's OWN
          // already-connected client DID render it before leaving — publish a
          // `community:message:deleted` on their personal `user:<id>` channel so
          // it disappears in real time instead of surviving until a reload.
          // Bounded by the leave-event timestamp so a redelivered stale "left"
          // can't delete a FRESH rejoin line (which is strictly newer).
          //
          // Gate on the RAW event status (LEFT / BANNED), not the mapped
          // `data.status`: mapMemberStatus collapses PENDING (and unknowns) into
          // "left", and a PENDING join-request sync must NOT purge a join line.
          const rawStatus = (event.data.status ?? "").toUpperCase();

          // NOTE: this used to write a 60 s `community:fresh-join:*` key that
          // suppressed `community:updated` list bumps for the member. It was
          // removed — see publishCommunityUpdated: `community:added` is
          // delivered synchronously at join time, so the window only ever
          // swallowed legitimate bumps.

          // Hard-deletes stale PERSONAL session lines of `types` for this user
          // and tombstones each on their own `user:<id>` channel so an
          // already-connected client that rendered the line learns it's gone
          // without waiting for a reload. Shared by the join-line cleanup below
          // and the ban-line cleanup on unban.
          const purgeAndTombstone = async (
            types: readonly string[],
            label: string,
            boundary?: Date
          ) => {
            const deletedIds = await this.messageRepo
              .deletePersonalJoinMessages({
                roomId: communityId,
                userId,
                types,
                beforeOrAt: boundary,
              })
              .catch((err: unknown) => {
                logger.warn(
                  `member.synced ${label}-cleanup failed community=${communityId} user=${userId}: ${String(err)}`
                );
                return [] as string[];
              });
            if (deletedIds.length === 0) return;
            logger.debug(
              `member.synced ${label}-cleanup: removed ${deletedIds.length} personal line(s) community=${communityId} user=${userId}`
            );
            for (const messageId of deletedIds) {
              const tombstone = buildDeletePayload({
                conversationType: "COMMUNITY",
                messageId,
                roomId: communityId,
                scope: "forEveryone",
                deletedBy: "",
              });
              await redis
                .publish(
                  `user:${userId}`,
                  JSON.stringify({
                    event: "community:message:deleted",
                    data: tombstone,
                  })
                )
                .catch((err: unknown) => {
                  logger.warn(
                    `member.synced ${label}-cleanup delete-publish failed community=${communityId} user=${userId} message=${messageId}: ${String(err)}`
                  );
                });
            }
          };

          if (rawStatus === "LEFT" || rawStatus === "BANNED") {
            const boundary = event.data.eventAt
              ? new Date(event.data.eventAt)
              : undefined;
            const safeBoundary =
              boundary && !Number.isNaN(boundary.getTime())
                ? boundary
                : undefined;
            await purgeAndTombstone(
              PERSONAL_JOIN_SESSION_TYPES,
              "join",
              safeBoundary
            );
            // Mute/unmute PERSONAL lines are cycle-scoped moderation history —
            // a rejoin must start a fresh membership (see reactivateMemberWithSnapshot),
            // so stale mute notices from the ending cycle can't outlive it either.
            await purgeAndTombstone(
              ["MEMBER_MUTED", "MEMBER_UNMUTED"],
              "mute",
              safeBoundary
            );
          }

          // Unban always transitions BANNED -> LEFT (never straight to ACTIVE —
          // a rejoin is a separate later event), so retiring the stale "You were
          // banned" PERSONAL line on the LEFT transition covers unban without
          // also firing on the ban itself (rawStatus === "BANNED", when the line
          // is being created, not retired). A plain voluntary leave/kick has no
          // ban line to match, so this is a harmless no-op for that case.
          if (rawStatus === "LEFT") {
            await purgeAndTombstone(["MEMBER_BANNED"], "ban");
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

        case "community.member.mute_msg_retracted": {
          // Telegram parity: on unmute, retract the CURRENT mute session's
          // "You are muted until …" PERSONAL line so it never sits alongside
          // the fresh unmute line in the affected member's history.
          const userId = event.data.userId;
          if (!userId) break;
          await this.communitySystemMessageService.retractPersonalMuteMessage({
            communityId,
            userId,
          });
          break;
        }

        case "community.invite_link_shared": {
          const {
            inviterId,
            recipientId,
            linkCode,
            communityId: cId,
            communityName,
            communityHandle,
            communityAvatarUrl,
            memberCount,
            inviteUrl,
            inviteDeepLink,
            isPermanent,
            inviterName,
            inviterAvatarUrl,
            eventAt,
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
            communityHandle: communityHandle ?? null,
            communityAvatarUrl: communityAvatarUrl ?? null,
            memberCount,
            inviteUrl,
            inviteDeepLink,
            isPermanent,
            inviterName,
            inviterAvatarUrl: inviterAvatarUrl ?? null,
            eventAt,
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
   * Idempotent per SHARE ACTION: `clientMessageId` is
   * `cinv:<communityId>:<linkCode>:<recipientId>:<eventAt>`. Each Bulk-Send call
   * mints a fresh `eventAt`, so N shares → N distinct messages (same behavior
   * as text/image/file messages). A RabbitMQ redelivery of the SAME event
   * carries the same `eventAt` and is deduped. `eventAt` is optional for
   * back-compat with in-flight events from older publishers; when absent, a
   * per-invocation nonce is used so distinct shares still don't collide.
   */
  private async deliverInviteLinkDm(params: {
    inviterId: string;
    recipientId: string;
    linkCode: string;
    communityId: string;
    communityName: string;
    communityHandle?: string | null;
    communityAvatarUrl?: string | null;
    memberCount?: number;
    inviteUrl?: string;
    inviteDeepLink?: string;
    isPermanent?: boolean;
    inviterName?: string;
    inviterAvatarUrl?: string | null;
    eventAt?: string;
  }): Promise<void> {
    const {
      inviterId,
      recipientId,
      linkCode,
      communityId,
      communityName,
      communityHandle = null,
      communityAvatarUrl = null,
      memberCount,
      inviteUrl,
      inviteDeepLink,
      isPermanent,
      inviterName,
      inviterAvatarUrl = null,
      eventAt,
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

    // 2. Idempotency — deterministic per SHARE ACTION (`eventAt` is minted once
    //    per Bulk-Send call in community-service). Distinct shares of the same
    //    community produce distinct messages; a RabbitMQ redelivery of the SAME
    //    event carries the same `eventAt` and is deduped. Fallback nonce keeps
    //    older in-flight events (without `eventAt`) from colliding.
    const shareNonce =
      eventAt ?? `${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    const clientMessageId = `cinv:${communityId}:${linkCode}:${recipientId}:${shareNonce}`;
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

    // 3. The invitation message, shaped like a call row (see
    //    CallChatMessageService): a dedicated `contentType`, the structured card
    //    under `content.invitation`, and only event-level metadata in
    //    `systemData`.
    //
    //    Built synchronously with no gRPC lookup because this event is firing
    //    the invite into existence right now: the recipient is guaranteed
    //    not-yet-a-member (bulk-send filters out ACTIVE members before
    //    publishing) and the code was just minted, so ACTIVE/false is the only
    //    truthful answer. Historical reads (`enrichMessages`) re-resolve the
    //    same object, since either fact can go stale later.
    const previewText = communityName
      ? `Invitation to join ${communityName}`
      : "Community invitation";
    const messageType = inviteContentType("COMMUNITY");
    const invitation = buildCommunityInvitationAction({
      communityId,
      communityName,
      communityHandle,
      communityAvatarUrl,
      memberCount,
      inviteCode: linkCode,
      deepLink: inviteDeepLink ?? inviteUrl ?? "",
      alreadyJoined: false,
      status: "ACTIVE",
    });
    const content = buildInvitationContent(previewText, invitation);
    // Event-level only: WHO shared WHAT, and the link identity needed to
    // re-resolve the card on read. Everything presentational lives on
    // `content.invitation` and is not duplicated here. `actorId`/`actorName` are
    // the names the shared private-system-text renderer reads — without them
    // the line personalizes to "Someone …".
    const systemData: Record<string, unknown> = {
      invitationType: "COMMUNITY",
      communityId,
      linkCode,
      // Link identity, not presentation: the https share URL has no home on
      // `content.invitation` (which carries the app deep link), so it is not a
      // duplicate.
      inviteUrl,
      isPermanent,
      inviterId,
      inviterName,
      actorId: inviterId,
      actorName: inviterName,
    };

    // 4. Allocate sequence + persist the invitation message. The create is guarded
    //    against the idempotency unique index losing a race (two events in
    //    flight): a duplicate-key error is treated as "already delivered".
    const seq = await this.privateRoomRepo.allocateSequence(room.roomId);
    const message = await this.privateMessageRepo
      .createMessage({
        roomId: room.roomId,
        senderId: inviterId,
        receiverId: recipientId,
        content,
        messageType,
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
          messageType,
          systemEvent: "COMMUNITY_INVITE",
          systemData,
          createdAt,
          sequenceNumber: message.sequenceNumber,
          revision: message.revision,
        },
        receiverId: recipientId,
      })
      .catch((err: unknown) =>
        logger.warn(
          `invite_link_shared: room bump failed room=${room!.roomId}: ${String(err)}`
        )
      );

    // 6. Live broadcast — the canonical message:new wire event (identical shape
    //    to a normal private message; the card rides on `content.invitation`).
    //    Reaches every device joined to the conversation room.
    const wireEvent = buildChatMessageEvent({
      id: message.id,
      clientMessageId,
      roomId: room.roomId,
      conversationType: "PRIVATE",
      senderId: inviterId,
      senderName: inviterName ?? "",
      senderAvatar: "",
      receiverId: recipientId,
      messageType,
      content,
      sequenceNumber: seq,
      serverTs: sentAt,
      systemEvent: "COMMUNITY_INVITE",
      systemData,
      // Legacy mirror of `content.invitation` — pre-existing mobile clients
      // read the card from here. Same object, never a second computation.
      systemAction: invitation,
      countInUnread: (message as unknown as { countInUnread?: boolean | null })
        .countInUnread,
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
      preview: {
        contentType: messageType,
        text: previewText,
        systemAction: invitation,
      },
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
      messageType,
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
