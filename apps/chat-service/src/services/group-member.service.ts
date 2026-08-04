import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@aimess/errors";

import { publishChatUserEvent } from "@aimess/redis";
import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";

import { SystemEvent } from "../types/enums.js";
import { assertGroupMember, isGroupMemberMuted } from "../lib/access-guard.js";
import { publishGroupMemberAddedSafe } from "../events/publish-group-member-added.js";
import { publishAdminReportIngestSafe } from "../events/publish-admin-report.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupSystemMessageService } from "./group-system-message.service.js";
import {
  resolveDisplayName,
  type UserSnapshotService,
} from "./user-snapshot.service.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import {
  resolveMediaUrl,
  resolveMediaUrlMap,
  urlFromMap,
} from "../lib/media-resolve.js";
import type { GroupMember } from "../generated/prisma/index.js";

/** Roster row + the identity fields the FE needs to render a member without extra lookups. */
export type EnrichedGroupMember = GroupMember & {
  displayName: string;
  username: string;
  avatarUrl: string;
  isDeletedUser: boolean;
  isMuted: boolean;
};

/**
 * Injected user-service gRPC dep so direct adds can be friend-gated (mirrors
 * PrivateRoomService.getOrCreateRoom's `checkFriendship`). Optional to keep the
 * older test wiring compiling — when omitted, addMember falls back to the
 * previous behavior (role + limit + status checks only).
 */
export interface GroupUserServiceClient {
  checkFriendship(userA: string, userB: string): Promise<boolean>;
}

export class GroupMemberService {
  constructor(
    private readonly memberRepo: GroupMemberRepository,
    private readonly roomRepo: GroupRoomRepository,
    private readonly sysMsg: GroupSystemMessageService,
    private readonly redis: Redis | Cluster,
    private readonly userServiceClient?: GroupUserServiceClient,
    /** Optional so existing 5-arg construction sites (tests) keep compiling; when
     *  absent the roster is returned bare, exactly as before. */
    private readonly userSnapshotService?: UserSnapshotService,
    private readonly cacheRepo?: CacheRepository
  ) {}

  /**
   * Adds (or reactivates) a member. By default posts a MEMBER_ADDED system
   * message attributed to `invitedBy`. The invite-link join path passes
   * `opts` to post MEMBER_JOINED attributed to the joining user instead.
   */
  async addMember(
    params: {
      roomId: string;
      userId: string;
      invitedBy?: string;
      role?: string;
    },
    opts?: {
      systemEvent?: SystemEvent;
      actorId?: string;
      /**
       * Invite-link self-join: the joining user is authorized by possessing a
       * valid link, so skip the OWNER/ADMIN actor check. Default (false) means
       * a direct add MUST be performed by an active OWNER/ADMIN.
       */
      skipActorAuthz?: boolean;
    }
  ): Promise<GroupMember> {
    const room = await this.roomRepo.findActiveByRoomId(params.roomId);
    if (!room) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");

    // Authorize the actor: only an active OWNER/ADMIN may add members (mirrors
    // the kick/updateRole guards). Without this, any authenticated user could
    // inject themselves or others into a private group (AUDIT H3).
    if (!opts?.skipActorAuthz) {
      if (!params.invitedBy) {
        throw new ForbiddenError("CHAT_INSUFFICIENT_PERMISSIONS");
      }
      await assertGroupMember(
        this.memberRepo,
        params.roomId,
        params.invitedBy,
        {
          roles: ["OWNER", "ADMIN"],
        }
      );
    }

    if (room.memberCount >= room.memberLimit) {
      throw new BadRequestError("CHAT_GROUP_MEMBER_LIMIT_REACHED");
    }

    // Friend-gate direct adds — parity with private DM's friendship check.
    // Skipped for invite-link self-joins (skipActorAuthz) and for the
    // OWNER-onboards-themselves creation path (invitedBy == userId).
    if (
      !opts?.skipActorAuthz &&
      params.invitedBy &&
      params.invitedBy !== params.userId &&
      this.userServiceClient
    ) {
      const isFriend = await this.userServiceClient.checkFriendship(
        params.invitedBy,
        params.userId
      );
      if (!isFriend) throw new ForbiddenError("CHAT_ADD_MEMBER_NOT_FRIEND");
    }

    const existing = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (existing && existing.status === "ACTIVE") {
      throw new ConflictError("CHAT_ALREADY_MEMBER");
    }
    // A banned member cannot rejoin (mirrors community's assertNotBanned join
    // gate) — without this, `ban` had no effect since upsert would silently
    // reactivate them on the next add/invite-link redemption.
    if (existing && existing.status === "BANNED") {
      throw new ForbiddenError("CHAT_BANNED_FROM_ROOM");
    }

    const member = await this.memberRepo.upsert(params.roomId, params.userId, {
      role: params.role || "MEMBER",
      status: "ACTIVE",
      joinedAt: new Date(),
      invitedBy: params.invitedBy || null,
      leftAt: null,
      kickedAt: null,
      kickedBy: null,
      kickReason: null,
      bannedAt: null,
      bannedBy: null,
    });

    await this.roomRepo.incMemberCount(params.roomId, 1);

    const systemEvent = opts?.systemEvent ?? SystemEvent.MEMBER_ADDED;
    await this.sysMsg.post({
      roomId: params.roomId,
      actorId: opts?.actorId ?? params.invitedBy ?? params.userId,
      systemEvent,
      systemData: { targetUserId: params.userId },
    });

    // Out-of-room push/inbox for the added member (additive to the in-room SYSTEM
    // message above). Skip invite-link self-joins (systemEvent MEMBER_JOINED) —
    // the user initiated the join and already knows, mirroring community JOINED.
    if (systemEvent === SystemEvent.MEMBER_ADDED) {
      publishGroupMemberAddedSafe({
        roomId: params.roomId,
        groupName: room.name,
        addedUserId: params.userId,
        actorId: opts?.actorId ?? params.invitedBy ?? params.userId,
        eventAt: new Date().toISOString(),
      });
    }

    // The new member isn't in `conv:<roomId>` yet (that room is joined only by
    // an explicit client `conv:join`), so no room broadcast can reach them.
    // Their personal `user:<id>` channel can — same reason community fans out
    // `community:added`. Payload is a full inbox row: the client upserts it
    // directly and must NOT back-fill from REST.
    this.emitGroupAdded(room, member, params.userId);

    return member;
  }

  /**
   * `group:added` → `user:<addedUserId>`. Fire-and-forget: a socket failure must
   * never fail the add. Re-reads the room so the row carries the preview/ts the
   * MEMBER_ADDED system message just wrote (the caller's copy predates it).
   */
  private emitGroupAdded(
    staleRoom: { roomId: string },
    member: GroupMember,
    addedUserId: string
  ): void {
    void (async () => {
      const room =
        (await this.roomRepo.findActiveByRoomId(staleRoom.roomId)) ?? null;
      if (!room) return;
      // Resolve-on-read at the publish boundary — raw object keys must never
      // land in the member's inbox cache (parity with createGroup / meta:updated).
      const resolvedAvatar = await resolveMediaUrl(room.avatar);
      await publishChatUserEvent(this.redis, addedUserId, "group:added", {
        type: "GROUP",
        roomId: room.roomId,
        lastMessageAt: room.lastMessageAt,
        lastMessageId: room.lastMessageId,
        lastMessage: room.lastMessagePreview ?? null,
        unreadCount: 0,
        isMuted: false,
        pinnedCount: room.pinnedCount,
        peer: null,
        name: room.name,
        avatar: resolvedAvatar,
        description: room.description,
        memberCount: room.memberCount,
        role: member.role,
        isJoined: true,
        addedAt: member.joinedAt,
      });
    })().catch((err: unknown) => {
      logger.warn(
        `GroupMemberService|group:added publish failed room=${staleRoom.roomId} user=${addedUserId}: ${String(err)}`
      );
    });
  }

  /**
   * `group:removed` → the FORMER member's own `user:<id>` channel. The frontend
   * (`GroupRemovedPayload`/`handleGroupRemoved` in MessageThreadsContext.tsx)
   * already had this exact contract wired up for multi-device sync — it was
   * simply never published from anywhere server-side until now. The
   * api-gateway ALSO reacts to it by force-`leave()`-ing every one of the
   * target's live sockets out of `conv:<roomId>`, mirroring the `group:added`
   * auto-JOIN this same channel already drives. Without this, a socket that
   * called `conv:join` while still ACTIVE keeps sitting in that Socket.IO
   * room forever (nothing else ever calls `conv:leave` for them), so they'd
   * keep receiving live message:new/typing/recording broadcasts for a group
   * they're no longer in. Covers leave, kick, and ban alike — the target's
   * own socket must never keep hearing a room it can no longer read or write
   * to. Fire-and-forget: never blocks or fails the membership-status change.
   */
  private emitGroupRemoved(
    roomId: string,
    userId: string,
    reason: "LEAVE" | "KICK" | "BAN"
  ): void {
    publishChatUserEvent(this.redis, userId, "group:removed", {
      roomId,
      reason,
      removedAt: new Date().toISOString(),
    }).catch((err: unknown) => {
      logger.warn(
        `GroupMemberService|group:removed publish failed room=${roomId} user=${userId} reason=${reason}: ${String(err)}`
      );
    });
  }

  async leave(
    roomId: string,
    userId: string,
    reason?: string
  ): Promise<GroupMember | null> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_NOT_A_MEMBER");

    if (member.role === "OWNER") {
      throw new BadRequestError("CHAT_OWNER_CANNOT_LEAVE");
    }

    const updated = await this.memberRepo.updateStatus(roomId, userId, "LEFT", {
      leftAt: new Date(),
    });
    await this.roomRepo.incMemberCount(roomId, -1);

    await this.sysMsg.post({
      roomId,
      actorId: userId,
      systemEvent: SystemEvent.MEMBER_LEFT,
      // Self-reported reason, shown only in moderator/admin surfaces — not
      // persisted as its own GroupMember column since kick/ban don't get one
      // either beyond kickReason; the system message is the audit trail.
      ...(reason ? { systemData: { reason } } : {}),
    });
    this.emitGroupRemoved(roomId, userId, "LEAVE");

    return updated;
  }

  async kick(params: {
    roomId: string;
    targetUserId: string;
    kickedBy: string;
    reason?: string;
  }): Promise<GroupMember | null> {
    const actor = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.kickedBy
    );
    if (!actor) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    if (!["OWNER", "ADMIN", "MODERATOR"].includes(actor.role)) {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    const target = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.targetUserId
    );
    if (!target) throw new NotFoundError("CHAT_NOT_A_MEMBER");

    // Cannot kick someone with equal or higher role
    const roleOrder = ["OWNER", "ADMIN", "MODERATOR", "MEMBER"];
    if (roleOrder.indexOf(actor.role) >= roleOrder.indexOf(target.role)) {
      throw new BadRequestError("CHAT_CANNOT_KICK_HIGHER_ROLE");
    }

    const updated = await this.memberRepo.updateStatus(
      params.roomId,
      params.targetUserId,
      "KICKED",
      {
        kickedAt: new Date(),
        kickedBy: params.kickedBy,
        kickReason: params.reason || null,
      }
    );
    await this.roomRepo.incMemberCount(params.roomId, -1);

    await this.sysMsg.post({
      roomId: params.roomId,
      actorId: params.kickedBy,
      systemEvent: SystemEvent.MEMBER_REMOVED,
      systemData: { targetUserId: params.targetUserId },
    });
    this.emitGroupRemoved(params.roomId, params.targetUserId, "KICK");

    return updated;
  }

  /**
   * Moderator-imposed mute — same role gate as kick (OWNER/ADMIN on anyone
   * lower; MODERATOR on MEMBER only), so a muted member cannot send/react
   * (enforced in GroupMessageService.sendMessage via assertGroupMemberNotMuted)
   * while keeping full read access. Distinct from `muteRoom` (self-notification
   * mute) — this is a moderation action performed BY someone else ON a member.
   */
  async muteMember(params: {
    roomId: string;
    targetUserId: string;
    mutedBy: string;
    mutedUntil?: Date | null;
  }): Promise<GroupMember | null> {
    const actor = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.mutedBy
    );
    if (!actor) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    if (!["OWNER", "ADMIN", "MODERATOR"].includes(actor.role)) {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    const target = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.targetUserId
    );
    if (!target) throw new NotFoundError("CHAT_NOT_A_MEMBER");

    const roleOrder = ["OWNER", "ADMIN", "MODERATOR", "MEMBER"];
    if (roleOrder.indexOf(actor.role) >= roleOrder.indexOf(target.role)) {
      throw new BadRequestError("CHAT_CANNOT_KICK_HIGHER_ROLE");
    }

    return this.memberRepo.setModerationMute(
      params.roomId,
      params.targetUserId,
      {
        mutedBy: params.mutedBy,
        mutedUntil: params.mutedUntil ?? null,
      }
    );
  }

  async unmuteMember(params: {
    roomId: string;
    targetUserId: string;
    actorId: string;
  }): Promise<GroupMember | null> {
    const actor = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.actorId
    );
    if (!actor) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    if (!["OWNER", "ADMIN", "MODERATOR"].includes(actor.role)) {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    return this.memberRepo.clearModerationMute(
      params.roomId,
      params.targetUserId
    );
  }

  /**
   * Ban a member: same permission/role-order rules as `kick`, but the target's
   * `status` becomes `"BANNED"` (not `"KICKED"`) and `bannedAt`/`bannedBy` are
   * populated — those two Prisma columns previously existed on the schema but
   * were never written or checked anywhere, so a "banned" group member was
   * functionally identical to an active one. `findActiveByRoomAndUser`'s
   * `status: "ACTIVE"` filter (used by every send/read/access-guard check)
   * already excludes non-ACTIVE members, so this closes both the write/read
   * gate AND (via `addMember`'s new check above) the rejoin gate, matching
   * community's hardened ban enforcement.
   */
  async ban(params: {
    roomId: string;
    targetUserId: string;
    bannedBy: string;
    reason?: string;
  }): Promise<GroupMember | null> {
    const actor = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.bannedBy
    );
    if (!actor) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    if (!["OWNER", "ADMIN", "MODERATOR"].includes(actor.role)) {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    const target = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.targetUserId
    );
    if (!target) throw new NotFoundError("CHAT_NOT_A_MEMBER");

    const roleOrder = ["OWNER", "ADMIN", "MODERATOR", "MEMBER"];
    if (roleOrder.indexOf(actor.role) >= roleOrder.indexOf(target.role)) {
      throw new BadRequestError("CHAT_CANNOT_KICK_HIGHER_ROLE");
    }

    const updated = await this.memberRepo.updateStatus(
      params.roomId,
      params.targetUserId,
      "BANNED",
      {
        bannedAt: new Date(),
        bannedBy: params.bannedBy,
        kickReason: params.reason || null,
      }
    );
    await this.roomRepo.incMemberCount(params.roomId, -1);

    await this.sysMsg.post({
      roomId: params.roomId,
      actorId: params.bannedBy,
      systemEvent: SystemEvent.MEMBER_BANNED,
      systemData: { targetUserId: params.targetUserId },
    });
    this.emitGroupRemoved(params.roomId, params.targetUserId, "BAN");

    return updated;
  }

  /**
   * Lift a ban. Actor must be OWNER/ADMIN/MODERATOR (same gate as `ban`). Does
   * NOT re-add the user as a member — it only clears the ban so a future
   * add/invite-link redemption is no longer rejected by `addMember`'s check.
   */
  async unban(params: {
    roomId: string;
    targetUserId: string;
    unbannedBy: string;
  }): Promise<GroupMember | null> {
    const actor = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.unbannedBy
    );
    if (!actor) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    if (!["OWNER", "ADMIN", "MODERATOR"].includes(actor.role)) {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    const target = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.targetUserId
    );
    if (!target || target.status !== "BANNED") {
      throw new NotFoundError("CHAT_NOT_A_MEMBER");
    }

    const updated = await this.memberRepo.updateStatus(
      params.roomId,
      params.targetUserId,
      "LEFT",
      { bannedAt: null, bannedBy: null }
    );

    await this.sysMsg.post({
      roomId: params.roomId,
      actorId: params.unbannedBy,
      systemEvent: SystemEvent.MEMBER_UNBANNED,
      systemData: { targetUserId: params.targetUserId },
    });

    return updated;
  }

  /**
   * Report a member of this group. Best-effort forwards a normalized row to
   * backoffice via the shared admin.report.ingest queue (same publisher as
   * private message reports). No local dedupe row is persisted — backoffice
   * owns the moderation ledger; adding one here would duplicate that state and
   * require a new Prisma model + migration for negligible gain.
   * ponytail: no local dedupe; add a chat-side unique index if abuse volume
   * shows repeated backoffice ingest of the same (reporter, target, room).
   */
  async reportMember(params: {
    roomId: string;
    targetUserId: string;
    reporterId: string;
    reason: string;
    description?: string;
  }): Promise<{ ok: true }> {
    if (params.reporterId === params.targetUserId) {
      throw new BadRequestError("CHAT_REPORT_OWN_MESSAGE");
    }
    // Reporter must be an active member of the group (mirrors private's
    // participant guard). Target may be any status — banned members can still
    // be reported for prior conduct.
    const reporter = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.reporterId
    );
    if (!reporter) throw new NotFoundError("CHAT_NOT_A_MEMBER");

    const target = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.targetUserId
    );
    if (!target) throw new NotFoundError("CHAT_NOT_A_MEMBER");

    publishAdminReportIngestSafe({
      type: "user",
      targetId: params.targetUserId,
      reporterId: params.reporterId,
      reason: params.reason,
      details: params.description?.trim() ? params.description.trim() : null,
      // Groups are not community-scoped.
      communityId: null,
      eventAt: new Date().toISOString(),
      // No local report row; identify the ingest via room + target for admin correlation.
      sourceReportId: `grp:${params.roomId}:${params.targetUserId}:${Date.now()}`,
    });

    return { ok: true };
  }

  /**
   * Mute/unmute personal notifications for this group — mirrors
   * PrivateRoomService.muteRoom/unmuteRoom. Private already has this; Group had
   * the storage field (`notificationSettings`) and even read it in the inbox
   * list, but no route ever wrote it.
   */
  async muteRoom(
    roomId: string,
    userId: string,
    muteUntil: Date | null
  ): Promise<GroupMember> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    const updated = await this.memberRepo.setMuted(roomId, userId, muteUntil);
    return updated ?? member;
  }

  async unmuteRoom(roomId: string, userId: string): Promise<GroupMember> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    const updated = await this.memberRepo.setUnmuted(roomId, userId);
    return updated ?? member;
  }

  async updateRole(params: {
    roomId: string;
    targetUserId: string;
    newRole: string;
    actorUserId: string;
  }): Promise<GroupMember | null> {
    const actor = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.actorUserId
    );
    if (!actor) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    if (!["OWNER", "ADMIN"].includes(actor.role)) {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    // Owner can set any role, admin can only set moderator/member
    if (actor.role !== "OWNER" && ["OWNER", "ADMIN"].includes(params.newRole)) {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    // Captured before the write so the system-message text can distinguish a
    // promotion from a demotion (and an ownership transfer) instead of a
    // generic "role changed to X" line.
    const target = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.targetUserId
    );

    // Ownership transfer: promoting a member to OWNER auto-demotes the current
    // OWNER to ADMIN and emits OWNERSHIP_TRANSFERRED instead of ROLE_CHANGED.
    // Guarded above (only actor.role === OWNER may set OWNER), so `actor` IS
    // the current owner.
    if (params.newRole === "OWNER") {
      await this.memberRepo.updateRole(
        params.roomId,
        params.actorUserId,
        "ADMIN"
      );
      const updated = await this.memberRepo.updateRole(
        params.roomId,
        params.targetUserId,
        "OWNER"
      );
      await this.sysMsg.post({
        roomId: params.roomId,
        actorId: params.actorUserId,
        systemEvent: SystemEvent.OWNERSHIP_TRANSFERRED,
        systemData: { targetUserId: params.targetUserId },
      });
      return updated;
    }

    const updated = await this.memberRepo.updateRole(
      params.roomId,
      params.targetUserId,
      params.newRole
    );

    await this.sysMsg.post({
      roomId: params.roomId,
      actorId: params.actorUserId,
      systemEvent: SystemEvent.ROLE_CHANGED,
      systemData: {
        targetUserId: params.targetUserId,
        oldRole: target?.role ?? "",
        newRole: params.newRole,
      },
    });

    return updated;
  }

  /**
   * Active roster, identity-enriched. The bare row carries only `userId`+`role`, which left the
   * FE rendering raw ids (`@da1311`) and blank avatars — it had no second source to join against.
   * Same batched snapshot + resolve-on-read media path `enrichMessages` uses: one snapshot lookup
   * and one URL resolve for the whole page, never per member.
   */
  async getMembers(
    roomId: string,
    params?: { limit?: number; cursor?: string | null }
  ): Promise<Array<GroupMember | EnrichedGroupMember>> {
    const members = await this.memberRepo.findActiveMembers(roomId, params);
    if (!members.length || !this.userSnapshotService || !this.cacheRepo) {
      return members.map((member) => ({
        ...member,
        isMuted: isGroupMemberMuted(member),
      }));
    }
    const snapshots = await this.userSnapshotService.getUserSnapshotsMap(
      members.map((m) => m.userId),
      this.cacheRepo
    );
    const avatarKeys: string[] = [];
    for (const snap of snapshots.values()) {
      const avatar = (snap as Record<string, unknown>).avatar;
      if (typeof avatar === "string" && avatar) avatarKeys.push(avatar);
    }
    const urlMap = await resolveMediaUrlMap(avatarKeys);
    return members.map((member) => {
      const snap = (snapshots.get(member.userId) || {}) as Record<
        string,
        unknown
      >;
      return {
        ...member,
        displayName: resolveDisplayName(snap),
        username: (snap.memberId as string) || "",
        avatarUrl: urlFromMap(urlMap, (snap.avatar as string) || ""),
        isDeletedUser: snap.isDeletedUser === true,
        isMuted: isGroupMemberMuted(member),
      };
    });
  }

  async countMembers(roomId: string): Promise<number> {
    return this.memberRepo.countActiveMembers(roomId);
  }
}
