import {
  BadRequestError,
  NotFoundError,
  TooManyRequestsError,
} from "@aimess/errors";
import { nanoid } from "nanoid";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import { SystemEvent } from "../types/enums.js";
import {
  assertGroupMember,
  assertGroupRoomWritable,
} from "../lib/access-guard.js";
import { resolveMediaUrl } from "../lib/media-resolve.js";
import { inviteContentType } from "@aimess/constants";
import {
  buildGroupInvitationAction,
  buildChatMessageEvent,
  buildInvitationContent,
} from "../lib/chat-message.serializer.js";
import { generateRoomId, buildParticipantsKey } from "../lib/room-id.js";
import { publishConvUpdatedSafe } from "../events/publish-conv-updated.js";
import { publishMessageSentSafe } from "../events/publish-message-sent.js";
import { resolveDisplayName } from "./user-snapshot.service.js";
import {
  fetchInviteIneligibility,
  INVITE_INELIGIBILITY_CODE,
} from "../lib/invite-recipient-gate.js";

import type { GroupInviteLinkRepository } from "../repositories/group-invite-link.repository.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { PrivateMessageRepository } from "../repositories/private-message.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import type { Redis, Cluster } from "ioredis";
import type { GroupInviteLink, GroupRoom } from "../generated/prisma/index.js";
import { GroupMemberService } from "./group-member.service.js";

export interface GroupBulkInviteResult {
  userId: string;
  status: "SENT" | "SKIPPED_ALREADY_MEMBER" | "FAILED";
  /** Set when `status === "FAILED"`: stable code AND `@aimess/constants`
   *  message key (INVITE_RECIPIENT_BLOCKED / _SUSPENDED / _DELETED /
   *  _NOT_FOUND). Absent on SENT/SKIPPED. */
  code?: string;
}

/** Shareable HTTPS invite URL for a group token: `https://aimess.me/g/<token>`
 * (mirrors community's `buildInviteUrl`). Falls back to the bare token when no
 * base URL is configured (local/dev). */
function buildGroupInviteUrl(token: string): string {
  return env.INVITE_LINK_BASE_URL
    ? `${env.INVITE_LINK_BASE_URL}/g/${token}`
    : token;
}

/** App deep-link for a group invite token: `aimess://join-group?token=<token>`. */
function buildGroupInviteDeepLink(token: string): string {
  return `aimess://join-group?token=${encodeURIComponent(token)}`;
}

export class GroupInviteLinkService {
  constructor(
    private readonly inviteLinkRepo: GroupInviteLinkRepository,
    private readonly roomRepo: GroupRoomRepository,
    private readonly memberRepo: GroupMemberRepository,
    // ponytail: optional — omitted in existing unit tests that only exercise
    // create/revoke/preview/join. Only `bulkSend` (share-with-DM) needs the
    // private-chat side, so it fails loudly there rather than at construction.
    private readonly privateRoomRepo?: PrivateRoomRepository,
    private readonly privateMessageRepo?: PrivateMessageRepository,
    private readonly userSnapshotService?: UserSnapshotService,
    private readonly cacheRepo?: CacheRepository,
    private readonly redis?: Redis | Cluster | null
  ) {}

  async create(params: {
    roomId: string;
    userId: string;
    expiresAt?: Date | null;
    maxUses?: number | null;
    shareName?: string;
  }): Promise<GroupInviteLink> {
    const room = await this.roomRepo.findActiveByRoomId(params.roomId);
    if (!room) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");
    // A frozen room takes no new members, so it must mint no new links either.
    assertGroupRoomWritable(room);

    const member = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (!member) throw new BadRequestError("CHAT_NOT_A_MEMBER");

    // Check settings
    const settings = (room.settings ?? {}) as Record<string, unknown>;
    if (!settings.allowMemberInviteLink && member.role === "MEMBER") {
      throw new BadRequestError("CHAT_MEMBERS_CANNOT_CREATE_LINKS");
    }

    const token = nanoid(24);

    return this.inviteLinkRepo.create({
      roomId: params.roomId,
      token,
      createdBy: params.userId,
      expiresAt: params.expiresAt || null,
      maxUses: params.maxUses || null,
      shareName: params.shareName || "",
    });
  }

  async revoke(token: string, userId: string): Promise<GroupInviteLink | null> {
    const link = await this.inviteLinkRepo.findActiveByToken(token);
    if (!link) throw new NotFoundError("CHAT_INVITE_LINK_NOT_FOUND");

    const member = await this.memberRepo.findActiveByRoomAndUser(
      link.roomId,
      userId
    );
    if (!member || member.role !== "ADMIN") {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    return this.inviteLinkRepo.revoke(token, userId);
  }

  async preview(token: string): Promise<{
    token: string;
    groupId: string;
    groupName: string;
    groupAvatar: string;
    description: string;
    memberCount: number;
    memberLimit: number;
    invitedByName: string;
  }> {
    const link = await this.inviteLinkRepo.findActiveByToken(token);
    if (!link) throw new NotFoundError("CHAT_INVITE_LINK_NOT_FOUND");

    // Check expiry
    if (link.expiresAt && new Date() > new Date(link.expiresAt)) {
      throw new BadRequestError("CHAT_INVITE_LINK_EXPIRED");
    }

    // Check max uses
    if (link.maxUses && link.usedCount >= link.maxUses) {
      throw new BadRequestError("CHAT_INVITE_LINK_USAGE_LIMIT");
    }

    const room = await this.roomRepo.findActiveByRoomId(link.roomId);
    if (!room) throw new NotFoundError("CHAT_GROUP_NO_LONGER_EXISTS");

    // Who is inviting — the preview screen names them. Same snapshot chokepoint every other name goes through, so a deleted inviter reads "Deleted Account" here too.
    // The snapshot service is an optional dependency (see the constructor), so an empty name is a valid answer, not a failure — the client falls back to a generic line.
    const inviterSnapshot =
      this.userSnapshotService && this.cacheRepo
        ? (
            await this.userSnapshotService.getUserSnapshotsMap(
              [link.createdBy],
              this.cacheRepo
            )
          ).get(link.createdBy)
        : null;

    return {
      token: link.token,
      groupId: room.roomId,
      groupName: room.name,
      groupAvatar: await resolveMediaUrl(room.avatar),
      description: room.description,
      memberCount: room.memberCount,
      memberLimit: room.memberLimit,
      invitedByName: inviterSnapshot ? resolveDisplayName(inviterSnapshot) : "",
    };
  }

  async join(
    token: string,
    userId: string,
    memberService: GroupMemberService
  ): Promise<{ room: GroupRoom }> {
    const link = await this.inviteLinkRepo.findActiveByToken(token);
    if (!link) throw new NotFoundError("CHAT_INVITE_LINK_NOT_FOUND");

    if (link.expiresAt && new Date() > new Date(link.expiresAt)) {
      throw new BadRequestError("CHAT_INVITE_LINK_EXPIRED");
    }
    if (link.maxUses && link.usedCount >= link.maxUses) {
      throw new BadRequestError("CHAT_INVITE_LINK_USAGE_LIMIT");
    }

    const room = await this.roomRepo.findActiveByRoomId(link.roomId);
    if (!room) throw new NotFoundError("CHAT_GROUP_NO_LONGER_EXISTS");
    assertGroupRoomWritable(room);

    await memberService.addMember(
      {
        roomId: link.roomId,
        userId,
        invitedBy: link.createdBy,
      },
      {
        systemEvent: SystemEvent.MEMBER_JOINED,
        actorId: userId,
        // Self-join: the user is authorized by the valid invite link, not by an
        // ADMIN role — skip the direct-add actor authorization.
        skipActorAuthz: true,
      }
    );

    await this.inviteLinkRepo.incrementUsedCount(token);

    return { room };
  }

  /**
   * Bulk-share a group invite link via private-chat system DMs — the group
   * counterpart of community's `bulkSendInviteLink`. Unlike community (a
   * separate service, delivered async over RabbitMQ), GroupRoom/PrivateRoom
   * both live in chat-service, so this writes the DM directly — no queue.
   *
   * 1. Verifies the caller is an ACTIVE member of the room (any role).
   * 2. Resolves the link to share — a specific `token`, the room's first
   *    active link, or auto-creates one (respecting the same
   *    `allowMemberInviteLink` gate as {@link create}).
   * 3. For each requested recipient (deduped, self excluded): skips users
   *    already an ACTIVE member, otherwise inserts a SYSTEM/GROUP_INVITE
   *    message into their private room with the inviter and runs the same
   *    live side-effects as a normal DM (message:new, conv:updated bump,
   *    offline push).
   */
  async bulkSend(params: {
    roomId: string;
    callerId: string;
    userIds: string[];
    token?: string;
  }): Promise<{
    token: string;
    results: GroupBulkInviteResult[];
  }> {
    const { roomId, callerId, token } = params;
    if (
      !this.privateRoomRepo ||
      !this.privateMessageRepo ||
      !this.userSnapshotService ||
      !this.cacheRepo
    ) {
      throw new BadRequestError("CHAT_GROUP_BULK_INVITE_NOT_CONFIGURED");
    }

    await assertGroupMember(this.memberRepo, roomId, callerId);
    await this.assertBulkSendRateLimit(callerId);

    const room = await this.roomRepo.findActiveByRoomId(roomId);
    if (!room) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");
    assertGroupRoomWritable(room);

    // Resolve the link to share.
    let link: GroupInviteLink;
    if (token) {
      const found = await this.inviteLinkRepo.findActiveByToken(token);
      if (!found || found.roomId !== roomId) {
        throw new NotFoundError("CHAT_INVITE_LINK_NOT_FOUND");
      }
      link = found;
    } else {
      const active = await this.inviteLinkRepo.findActiveByRoom(roomId);
      link = active[0] ?? (await this.create({ roomId, userId: callerId }));
    }

    const userIds = [
      ...new Set(params.userIds.filter((id) => id !== callerId)),
    ];
    if (!userIds.length) return { token: link.token, results: [] };

    const groupAvatarUrl = await resolveMediaUrl(room.avatar);
    const inviterSnapshots = await this.userSnapshotService.getUserSnapshotsMap(
      [callerId],
      this.cacheRepo
    );
    const inviterName = resolveDisplayName(inviterSnapshots.get(callerId));

    // Minted ONCE per bulk-send call — N recipients of the SAME call get
    // distinct messages (differ by recipientId), while a client retry of the
    // whole call reuses this nonce and is deduped per-recipient below.
    const shareNonce = `${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;

    // Recipient-account gate (deleted / suspended / blocked / missing), one
    // batch for the whole send. Same helper + codes as community-service's
    // invite paths — an invite DM must never be written to a recipient who
    // cannot act on it, and never across a block in either direction.
    const ineligible = await fetchInviteIneligibility(callerId, userIds);

    const results: GroupBulkInviteResult[] = [];
    for (const recipientId of userIds) {
      const blocker = ineligible.get(recipientId);
      if (blocker) {
        results.push({
          userId: recipientId,
          status: "FAILED",
          code: INVITE_INELIGIBILITY_CODE[blocker],
        });
        continue;
      }

      const alreadyMember = await this.memberRepo.findActiveByRoomAndUser(
        roomId,
        recipientId
      );
      if (alreadyMember) {
        results.push({ userId: recipientId, status: "SKIPPED_ALREADY_MEMBER" });
        continue;
      }
      await this.deliverInviteDm({
        roomId,
        inviterId: callerId,
        inviterName,
        recipientId,
        groupId: room.roomId,
        groupName: room.name,
        groupAvatarUrl,
        memberCount: room.memberCount,
        token: link.token,
        shareNonce,
      });
      results.push({ userId: recipientId, status: "SENT" });
    }

    return { token: link.token, results };
  }

  /** Fixed-window per-user cap; fails open on Redis outage (see community's identical policy). */
  private async assertBulkSendRateLimit(userId: string): Promise<void> {
    if (!this.redis) return;
    const key = `group:invite-rl:bulk:${userId}`;
    try {
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, 600);
      if (count > 20) {
        throw new TooManyRequestsError("CHAT_GROUP_INVITE_RATE_LIMITED");
      }
    } catch (err) {
      if (err instanceof TooManyRequestsError) throw err;
      logger.error(
        `group bulk-invite rate-limit check failed (failing open) key=${key}: ${String(err)}`
      );
    }
  }

  /**
   * Creates/reuses the private room between inviter and recipient, then inserts
   * a SYSTEM message carrying the group invite card and runs the same live
   * side-effects as a normal personal message. Mirrors
   * `community-room-sync.consumer.ts#deliverInviteLinkDm` — see that file for
   * the fuller rationale (bypasses friendship check; idempotent per share
   * action via `clientMessageId`).
   */
  private async deliverInviteDm(params: {
    roomId: string;
    inviterId: string;
    inviterName: string;
    recipientId: string;
    groupId: string;
    groupName: string;
    groupAvatarUrl: string;
    memberCount: number;
    token: string;
    shareNonce: string;
  }): Promise<void> {
    const {
      inviterId,
      inviterName,
      recipientId,
      groupId,
      groupName,
      groupAvatarUrl,
      memberCount,
      token,
      shareNonce,
    } = params;
    const privateRoomRepo = this.privateRoomRepo!;
    const privateMessageRepo = this.privateMessageRepo!;

    const key = buildParticipantsKey(inviterId, recipientId);
    let room = await privateRoomRepo.findByParticipantsKey(key);
    if (!room) {
      room = await privateRoomRepo.create({
        roomId: generateRoomId("prv"),
        participants: [inviterId, recipientId].sort(),
        participantsKey: key,
      });
    }

    const clientMessageId = `ginv:${groupId}:${token}:${recipientId}:${shareNonce}`;
    const existing = await privateMessageRepo.findByClientMessageId(
      room.roomId,
      inviterId,
      clientMessageId
    );
    if (existing) return; // already delivered (retry of the same bulk-send call)

    const previewText = groupName
      ? `Invitation to join ${groupName}`
      : "Group invitation";
    // Server-derived, canonical URL/deep-link — mirrors community's
    // buildInviteUrl/buildInviteDeepLink. The client-supplied `inviteUrl` (if
    // any) was the root cause of "Join Now" doing nothing: it was optional and
    // routinely omitted, leaving the card's deepLink empty. Always compute
    // both here so the card is actionable regardless of what the client sent.
    const resolvedInviteUrl = buildGroupInviteUrl(token);
    const inviteDeepLink = buildGroupInviteDeepLink(token);
    // Same shape as the community invite and as a call row: dedicated
    // `contentType`, structured card on `content.invitation`, event-level
    // metadata only in `systemData`.
    const messageType = inviteContentType("GROUP");
    const invitation = buildGroupInvitationAction({
      groupId,
      groupName,
      groupAvatarUrl,
      memberCount,
      inviteToken: token,
      deepLink: inviteDeepLink,
      alreadyJoined: false,
      status: "ACTIVE",
    });
    const content = buildInvitationContent(previewText, invitation);
    const systemData: Record<string, unknown> = {
      invitationType: "GROUP",
      groupId,
      token,
      // Link identity, not presentation: the https share URL has no home on
      // `content.invitation` (which carries the app deep link), so it is not a
      // duplicate.
      inviteUrl: resolvedInviteUrl,
      inviterId,
      inviterName,
      // Read by the shared private-system-text renderer; without them the line
      // personalizes to "Someone shared a group invite".
      actorId: inviterId,
      actorName: inviterName,
    };

    const seq = await privateRoomRepo.allocateSequence(room.roomId);
    const message = await privateMessageRepo
      .createMessage({
        roomId: room.roomId,
        senderId: inviterId,
        receiverId: recipientId,
        content,
        messageType,
        systemEvent: SystemEvent.GROUP_INVITE,
        systemData,
        clientMessageId,
        sequenceNumber: seq,
      })
      .catch((err: unknown) => {
        const sig = `${(err as { code?: string })?.code ?? ""} ${
          (err as Error)?.message ?? ""
        }`;
        if (sig.includes("P2002") || sig.includes("E11000")) return null;
        throw err;
      });
    if (!message) return; // duplicate create race — already delivered

    const createdAt =
      message.createdAt instanceof Date ? message.createdAt : new Date();
    const sentAt = createdAt.getTime();

    void privateRoomRepo
      .updateRoomOnNewMessage({
        roomId: room.roomId,
        message: {
          _id: message.id,
          content,
          senderId: inviterId,
          messageType,
          systemEvent: SystemEvent.GROUP_INVITE,
          systemData,
          createdAt,
          sequenceNumber: message.sequenceNumber,
          revision: message.revision,
        },
        receiverId: recipientId,
      })
      .catch((err: unknown) =>
        logger.warn(
          `group_invite_shared: room bump failed room=${room!.roomId}: ${String(err)}`
        )
      );

    const wireEvent = buildChatMessageEvent({
      id: message.id,
      clientMessageId,
      roomId: room.roomId,
      conversationType: "PRIVATE",
      senderId: inviterId,
      senderName: inviterName,
      senderAvatar: "",
      receiverId: recipientId,
      messageType,
      content,
      sequenceNumber: seq,
      serverTs: sentAt,
      systemEvent: SystemEvent.GROUP_INVITE,
      systemData,
      // Legacy mirror of `content.invitation` — see the community consumer.
      systemAction: invitation,
      countInUnread: (message as unknown as { countInUnread?: boolean | null })
        .countInUnread,
    });
    if (this.redis) {
      await this.redis
        .publish(
          `conv:${room.roomId}`,
          JSON.stringify({ event: "message:new", data: wireEvent })
        )
        .catch((err: unknown) =>
          logger.warn(
            `group_invite_shared: Redis publish failed for room=${room!.roomId}: ${String(err)}`
          )
        );
    }

    if (this.redis) {
      publishConvUpdatedSafe({
        redis: this.redis,
        type: "PRIVATE",
        roomId: room.roomId,
        senderId: inviterId,
        senderName: inviterName ?? "",
        recipientIds: [inviterId, recipientId],
        lastMessageId: message.id,
        lastMessageAt: sentAt,
        preview: {
          contentType: messageType,
          text: previewText,
          systemAction: invitation,
        },
      });
    }

    publishMessageSentSafe({
      conversationId: room.roomId,
      conversationType: "PRIVATE",
      messageId: message.id,
      clientMessageId,
      senderId: inviterId,
      senderName: inviterName,
      senderAvatar: "",
      preview: previewText,
      messageType,
      sentAt,
      recipientIds: [recipientId],
    });
  }

  async getActiveLinks(
    roomId: string,
    userId: string
  ): Promise<GroupInviteLink[]> {
    // Invite tokens grant group entry, so listing them must be restricted to an
    // active ADMIN of the room — not any authenticated user (AUDIT H4).
    await assertGroupMember(this.memberRepo, roomId, userId, {
      roles: ["ADMIN"],
    });
    return this.inviteLinkRepo.findActiveByRoom(roomId);
  }

  async countActiveLinks(roomId: string): Promise<number> {
    return this.inviteLinkRepo.countActiveByRoom(roomId);
  }
}
