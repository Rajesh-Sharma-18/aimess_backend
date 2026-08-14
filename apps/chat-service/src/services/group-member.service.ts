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
import {
  assertGroupMember,
  assertGroupReadAccess,
  isGroupMemberMuted,
} from "../lib/access-guard.js";
import {
  publishGroupMemberAddedSafe,
  publishGroupMemberMuteSafe,
} from "../events/publish-group-member-added.js";
import { ChatEvents } from "@aimess/shared-types";
import { publishUserReport } from "../lib/report-user.js";
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
       * valid link, so skip the staff actor check. Default (false) means
       * a direct add MUST be performed by an active ADMIN/MODERATOR.
       */
      skipActorAuthz?: boolean;
      /**
       * Batch add ({@link addMembers}): suppress the per-member MEMBER_ADDED
       * system line and the `group:added` inbox push. The batch posts ONE
       * grouped system line for the whole operation and then emits
       * `group:added` — in that order, so the new member's inbox row carries
       * the grouped preview rather than a pre-add one.
       */
      deferAnnouncements?: boolean;
    }
  ): Promise<GroupMember> {
    const room = await this.roomRepo.findActiveByRoomId(params.roomId);
    if (!room) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");

    // Authorize the actor: only active staff may add members. Without this, any
    // authenticated user could inject themselves or others into a private group
    // (AUDIT H3). MODERATOR is included — adding is a growth action, not a
    // destructive one, so it stays below the updateRole bar (ADMIN only).
    if (!opts?.skipActorAuthz) {
      if (!params.invitedBy) {
        throw new ForbiddenError("CHAT_INSUFFICIENT_PERMISSIONS");
      }
      await assertGroupMember(
        this.memberRepo,
        params.roomId,
        params.invitedBy,
        {
          roles: ["ADMIN", "MODERATOR"],
        }
      );
    }

    // Resolve the existing row BEFORE the capacity check: a re-add of someone
    // who is still ACTIVE is a no-op that must report CHAT_ALREADY_MEMBER, not
    // a capacity failure. A KICKED/LEFT row already gave its slot back
    // (`incMemberCount(-1)` on the removal), so a genuine re-add is measured
    // against the freed count and succeeds whenever a slot exists.
    const existing = await this.memberRepo.findByRoomAndUser(
      params.roomId,
      params.userId
    );
    if (existing && existing.status === "ACTIVE") {
      throw new ConflictError("CHAT_ALREADY_MEMBER");
    }
    // Groups have no ban feature. Legacy BANNED rows are treated as removed, so
    // the upsert below re-admits them (it already clears bannedAt/bannedBy).

    if (room.memberCount >= room.memberLimit) {
      throw new BadRequestError("CHAT_GROUP_MEMBER_LIMIT_REACHED");
    }

    // Friend-gate direct adds — parity with private DM's friendship check.
    // Skipped for invite-link self-joins (skipActorAuthz) and for the
    // creator-onboards-themselves creation path (invitedBy == userId).
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
    if (!opts?.deferAnnouncements) {
      await this.sysMsg.post({
        roomId: params.roomId,
        actorId: opts?.actorId ?? params.invitedBy ?? params.userId,
        systemEvent,
        systemData: { targetUserId: params.userId },
      });
    }

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
    if (!opts?.deferAnnouncements) {
      this.emitGroupAdded(room, member, params.userId);
    }

    // Roster fan-out to everyone ALREADY in the group — the exact counterpart of
    // the `group:member:removed` every removal path publishes. Without it an add
    // was the only membership change with no realtime signal, so the admin's own
    // Group Info stayed at the pre-add count and roster until a manual refresh
    // (the add is the caller's own request, but the count lives on a socket-fed
    // row, not on the mutation response). `group:member:updated` is reused
    // deliberately rather than minting a `group:member:added`: its payload
    // already carries `memberId` + `role` + the authoritative `memberCount`, and
    // every consumer of it (roster invalidation, member count, own-role patch)
    // is exactly the reaction an add needs. `previousRole` is empty because
    // there was no active membership to change from.
    await this.publishRosterChange({
      roomId: params.roomId,
      event: "group:member:updated",
      memberId: params.userId,
      actorId: opts?.actorId ?? params.invitedBy ?? params.userId,
      extra: { role: member.role, previousRole: "" },
    });

    return member;
  }

  /**
   * Adds MANY members in ONE operation and announces them with ONE grouped
   * MEMBER_ADDED system line ("Krish added Jane, Peter and 3 others") — the
   * WhatsApp behaviour. The batch relationship lives on the row itself
   * (`systemData.targetUserIds`), so it survives reload, reconnect and REST
   * history; clients never time-group anything.
   *
   * Per-member failures (already a member, not a friend, capacity reached) are
   * reported in `skipped` and are NOT named in the system line — only members
   * this operation actually added. Request-level failures (unknown room, caller
   * not staff) still throw, so an unauthorized batch is rejected whole.
   */
  async addMembers(params: {
    roomId: string;
    userIds: string[];
    invitedBy: string;
  }): Promise<{
    added: GroupMember[];
    skipped: { userId: string; reason: string }[];
  }> {
    const room = await this.roomRepo.findActiveByRoomId(params.roomId);
    if (!room) throw new NotFoundError("CHAT_GROUP_NOT_FOUND");
    // Fail the whole request (not each member) when the caller may not add.
    await assertGroupMember(this.memberRepo, params.roomId, params.invitedBy, {
      roles: ["ADMIN", "MODERATOR"],
    });

    const added: GroupMember[] = [];
    const skipped: { userId: string; reason: string }[] = [];
    // Duplicate ids in one request must not add (or announce) the same member
    // twice — the second pass would resolve to CHAT_ALREADY_MEMBER anyway.
    for (const userId of [...new Set(params.userIds.filter(Boolean))]) {
      try {
        added.push(
          await this.addMember(
            { roomId: params.roomId, userId, invitedBy: params.invitedBy },
            { deferAnnouncements: true }
          )
        );
      } catch (err) {
        skipped.push({
          userId,
          reason: err instanceof Error ? err.message : "CHAT_ADD_MEMBER_FAILED",
        });
      }
    }

    if (added.length > 0) {
      await this.sysMsg.post({
        roomId: params.roomId,
        actorId: params.invitedBy,
        systemEvent: SystemEvent.MEMBER_ADDED,
        // A single successful add keeps the classic one-target shape, so nothing
        // downstream (self-preview subject resolution, existing clients) changes.
        systemData:
          added.length === 1
            ? { targetUserId: added[0]!.userId }
            : { targetUserIds: added.map((member) => member.userId) },
      });
      // After the grouped line, so each new member's inbox row is seeded with it.
      for (const member of added) {
        this.emitGroupAdded(room, member, member.userId);
      }
    }

    return { added, skipped };
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

  /**
   * Roster-change fan-out to the REMAINING members — the group counterpart of
   * community's `community:member:removed` / `community:member:updated`.
   *
   * A member sitting on the chat LIST (never called `conv:join`) only ever
   * hears their own `user:<id>` channel, so a room-only broadcast leaves their
   * member count and role badges stale until a manual refetch. Published to
   * BOTH `conv:<roomId>` (open room) and every active member's `user:<id>`
   * (list view, other devices), exactly like `publishMuteStateChange`.
   *
   * The affected member themselves is NOT special-cased here: a removed member
   * already gets `group:removed` (which also force-leaves their sockets), and a
   * role-changed member is still in the active roster below.
   *
   * Best-effort — a Redis hiccup never fails the originating moderation write.
   */
  private async publishRosterChange(args: {
    roomId: string;
    event: "group:member:removed" | "group:member:updated";
    memberId: string;
    actorId: string;
    extra?: Record<string, unknown>;
    // When set (removal only), skip this user's own sockets on the
    // `conv:<roomId>` broadcast — the removed member must not receive a roster
    // event carrying their own memberId (a client's generic "member removed"
    // handler could mistake it for something to act on). They already get the
    // authoritative `group:removed` on their personal channel. Left undefined
    // for role updates, where the subject SHOULD hear their own change.
    excludeUserId?: string;
  }): Promise<void> {
    const { roomId, event, memberId, actorId, extra, excludeUserId } = args;
    try {
      const [room, roster] = await Promise.all([
        this.roomRepo.findActiveByRoomId(roomId),
        this.memberRepo.findActiveMembers(roomId, { limit: 500 }),
      ]);
      const payload = {
        roomId,
        conversationType: "GROUP" as const,
        memberId,
        actorId,
        memberCount: room?.memberCount ?? roster.length,
        updatedAt: Date.now(),
        ...(extra ?? {}),
      };
      await Promise.all([
        this.redis.publish(
          `conv:${roomId}`,
          JSON.stringify({
            event,
            ...(excludeUserId ? { excludeUserId } : {}),
            data: payload,
          })
        ),
        ...roster.map((m) =>
          publishChatUserEvent(this.redis, m.userId, event, payload)
        ),
      ]);
    } catch (err) {
      logger.warn(
        `GroupMemberService|${event} broadcast failed room=${roomId} member=${memberId}: ${String(err)}`
      );
    }
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

    if (member.role === "ADMIN") {
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
    await this.publishRosterChange({
      roomId,
      event: "group:member:removed",
      memberId: userId,
      actorId: userId,
      extra: { reason: "LEAVE" },
    });

    return updated;
  }

  /**
   * `asPlatformAdmin` (backoffice removal) skips ONLY the in-group actor lookup
   * and role-order check — `kickedBy` is then an AdminUser.id, not a member.
   * The system message is posted actor-less for the same reason: that id would
   * not resolve to a user snapshot in anyone's client.
   */
  async kick(params: {
    roomId: string;
    targetUserId: string;
    kickedBy: string;
    reason?: string;
    asPlatformAdmin?: boolean;
  }): Promise<GroupMember | null> {
    const actor = params.asPlatformAdmin
      ? null
      : await this.memberRepo.findActiveByRoomAndUser(
          params.roomId,
          params.kickedBy
        );
    if (!params.asPlatformAdmin) {
      if (!actor) throw new NotFoundError("CHAT_NOT_A_MEMBER");
      if (!["ADMIN", "MODERATOR"].includes(actor.role)) {
        throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
      }
    }

    const target = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.targetUserId
    );
    if (!target) throw new NotFoundError("CHAT_NOT_A_MEMBER");

    // Cannot kick someone with equal or higher role (in-group actors only).
    if (actor) {
      const roleOrder = ["ADMIN", "MODERATOR", "MEMBER"];
      if (roleOrder.indexOf(actor.role) >= roleOrder.indexOf(target.role)) {
        throw new BadRequestError("CHAT_CANNOT_KICK_HIGHER_ROLE");
      }
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

    // Evict first (see ban() for the ordering rationale), then post the removal
    // line and roster event with the target hard-excluded — a kicked member
    // must not receive the "Admin removed X" line about themselves either.
    this.emitGroupRemoved(params.roomId, params.targetUserId, "KICK");
    await this.sysMsg.post({
      roomId: params.roomId,
      actorId: params.asPlatformAdmin ? null : params.kickedBy,
      systemEvent: SystemEvent.MEMBER_REMOVED,
      systemData: { targetUserId: params.targetUserId },
      excludeUserId: params.targetUserId,
      // backoffice-service already audited this removal against the admin who
      // ordered it; mirroring here too would double the row.
      skipAdminActivity: params.asPlatformAdmin,
    });
    await this.publishRosterChange({
      roomId: params.roomId,
      event: "group:member:removed",
      memberId: params.targetUserId,
      actorId: params.kickedBy,
      extra: { reason: "KICK" },
      excludeUserId: params.targetUserId,
    });

    return updated;
  }

  /**
   * Broadcasts a moderation MUTE/UNMUTE state change to every consumer that
   * needs it — the single source of truth for "this group member's mute
   * changed", and the direct counterpart of community-service's
   * `_publishMuteStateChange`:
   *
   *   1. `group:member:muted` / `group:member:unmuted` into `conv:<roomId>` so
   *      every member's roster badge updates live, AND onto the affected
   *      member's own `user:<id>` channel so EVERY logged-in device (web,
   *      Android, iOS) enables/disables its composer with no refetch — the
   *      `user:<id>` leg is what makes multi-device sync work for a member who
   *      never called `conv:join` (sitting on the chat list, app backgrounded).
   *   2. on MUTE only, a `typing:stop` / `recording:stop` for the target so a
   *      member muted mid-keystroke does not leave a stuck indicator on every
   *      peer's screen.
   *
   * Used by manual mute, manual unmute AND the auto-unmute sweep, so the wire
   * payload is byte-identical regardless of trigger. Best-effort: a Redis
   * hiccup never fails the originating moderation request.
   *
   * @param actorId the admin/moderator who acted; "" for an automatic expiry.
   */
  private async publishMuteStateChange(args: {
    roomId: string;
    targetUserId: string;
    isMuted: boolean;
    mutedUntil: Date | null;
    actorId: string;
  }): Promise<void> {
    const { roomId, targetUserId, isMuted, mutedUntil, actorId } = args;
    const event = isMuted ? "group:member:muted" : "group:member:unmuted";

    // Out-of-socket leg, exactly as community does it: a target whose devices
    // were ALL offline when the mute landed gets a push/inbox row instead of
    // discovering the mute from a rejected send. Fire-and-forget; needs the
    // room name for the copy, so the lookup failing just skips the push.
    void Promise.resolve(this.roomRepo?.findActiveByRoomId?.(roomId) ?? null)
      .then((room) => {
        publishGroupMemberMuteSafe(
          isMuted
            ? ChatEvents.GROUP_MEMBER_MUTED
            : ChatEvents.GROUP_MEMBER_UNMUTED,
          {
            roomId,
            groupName: room?.name ?? "",
            targetUserId,
            actorId,
            mutedUntil: isMuted && mutedUntil ? mutedUntil.toISOString() : null,
            eventAt: new Date().toISOString(),
          }
        );
      })
      .catch(() => {});
    // Epoch ms on the wire, matching community's mute payload exactly.
    const payload = {
      roomId,
      conversationType: "GROUP" as const,
      memberId: targetUserId,
      isMuted,
      mutedUntil: isMuted && mutedUntil ? mutedUntil.getTime() : null,
      actorId,
      updatedAt: Date.now(),
    };

    try {
      await Promise.all([
        this.redis.publish(
          `conv:${roomId}`,
          JSON.stringify({ event, data: payload })
        ),
        publishChatUserEvent(this.redis, targetUserId, event, payload),
      ]);

      // Scenario 1: muted mid-typing — retract the indicator immediately
      // instead of waiting out the 6 s presence TTL.
      if (isMuted) {
        const stop = {
          conversationId: roomId,
          conversationType: "GROUP" as const,
          userId: targetUserId,
          timestamp: Date.now(),
        };
        await this.redis.publish(
          `conv:${roomId}`,
          JSON.stringify({ event: "recording:stop", data: stop })
        );
        const roster = await this.memberRepo.findActiveMembers(roomId, {
          limit: 500,
        });
        await Promise.all(
          roster
            .filter((m) => m.userId !== targetUserId)
            .map((m) =>
              publishChatUserEvent(this.redis, m.userId, "typing:stop", stop)
            )
        );
      }
    } catch (err) {
      logger.warn(
        `GroupMemberService|${event} broadcast failed room=${roomId} target=${targetUserId}: ${String(err)}`
      );
    }
  }

  /**
   * Moderator-imposed mute — same role gate as kick (ADMIN on anyone lower;
   * MODERATOR on MEMBER only), so a muted member cannot send/react/edit/
   * delete/pin (enforced across every group write path via
   * `assertGroupMemberNotMuted`) while keeping full read access. Distinct from
   * `muteRoom` (self-notification mute) — this is a moderation action performed
   * BY someone else ON a member. Mirrors community-service's `muteMember`.
   */
  async muteMember(params: {
    roomId: string;
    targetUserId: string;
    mutedBy: string;
    mutedUntil?: Date | null;
  }): Promise<GroupMember | null> {
    // Parity with community's "you cannot mute yourself" rule; without it an
    // ADMIN outranks nobody and would fall through the role-order check below.
    if (params.mutedBy === params.targetUserId) {
      throw new BadRequestError("CHAT_CANNOT_MUTE_SELF");
    }

    const actor = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.mutedBy
    );
    if (!actor) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    if (!["ADMIN", "MODERATOR"].includes(actor.role)) {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    const target = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.targetUserId
    );
    if (!target) throw new NotFoundError("CHAT_NOT_A_MEMBER");

    const roleOrder = ["ADMIN", "MODERATOR", "MEMBER"];
    if (roleOrder.indexOf(actor.role) >= roleOrder.indexOf(target.role)) {
      throw new BadRequestError("CHAT_CANNOT_KICK_HIGHER_ROLE");
    }

    const mutedUntil = params.mutedUntil ?? null;
    const updated = await this.memberRepo.setModerationMute(
      params.roomId,
      params.targetUserId,
      { mutedBy: params.mutedBy, mutedUntil }
    );

    await this.publishMuteStateChange({
      roomId: params.roomId,
      targetUserId: params.targetUserId,
      isMuted: true,
      mutedUntil,
      actorId: params.mutedBy,
    });

    logger.info(
      `Group member muted: room=${params.roomId} by=${params.mutedBy} target=${params.targetUserId} until=${mutedUntil?.toISOString() ?? "(indefinite)"}`
    );

    return updated;
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
    if (!["ADMIN", "MODERATOR"].includes(actor.role)) {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    const target = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.targetUserId
    );
    if (!target) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    // Community parity: unmuting someone who isn't muted is a 404, and a
    // fully-expired timed mute counts as not muted (lazy expiry).
    if (!isGroupMemberMuted(target)) {
      throw new NotFoundError("CHAT_MEMBER_NOT_MUTED");
    }

    const updated = await this.memberRepo.clearModerationMute(
      params.roomId,
      params.targetUserId
    );

    await this.publishMuteStateChange({
      roomId: params.roomId,
      targetUserId: params.targetUserId,
      isMuted: false,
      mutedUntil: null,
      actorId: params.actorId,
    });

    logger.info(
      `Group member unmuted: room=${params.roomId} by=${params.actorId} target=${params.targetUserId}`
    );

    return updated;
  }

  /**
   * Auto-unmute sweep — called on an interval by the group mute sweeper.
   *
   * Enforcement correctness does NOT depend on this: `isGroupMemberMuted`
   * applies lazy expiry the instant `moderationMutedUntil` passes, so posting
   * rights come back on their own. The sweep exists to deliver the REALTIME
   * signal (`group:member:unmuted` → composer re-enables on every device with
   * no refresh) and to clear the stale flag. Exactly-once across instances via
   * the atomic per-row claim. Mirrors community's `expireDueMutes`.
   *
   * @returns how many mutes were actually expired this call (drain until short).
   */
  async expireDueModerationMutes(limit: number): Promise<number> {
    const now = new Date();
    const rows = await this.memberRepo.findExpiredModerationMutes({
      now,
      limit,
    });
    if (rows.length === 0) return 0;

    let expired = 0;
    for (const row of rows) {
      // Only the instance that wins the claim fires the side-effects.
      const claimed = await this.memberRepo.claimExpiredModerationMute(
        row.id,
        now
      );
      if (claimed !== 1) continue;
      expired++;
      // actorId "" — an automatic expiry has no acting moderator.
      await this.publishMuteStateChange({
        roomId: row.roomId,
        targetUserId: row.userId,
        isMuted: false,
        mutedUntil: null,
        actorId: "",
      });
    }
    return expired;
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
    if (!["ADMIN", "MODERATOR"].includes(actor.role)) {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    const target = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.targetUserId
    );
    if (!target) throw new NotFoundError("CHAT_NOT_A_MEMBER");

    const roleOrder = ["ADMIN", "MODERATOR", "MEMBER"];
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

    // Evict the target's sockets from conv:<roomId> FIRST (the gateway reacts
    // to group:removed), so the window in which a concurrent normal message
    // could still reach them is as small as possible. The ban system line and
    // the roster event below are additionally hard-excluded from the target
    // regardless of eviction timing (excludeUserId), so the target never sees
    // its own ban announcement — remaining members still do.
    this.emitGroupRemoved(params.roomId, params.targetUserId, "BAN");
    await this.sysMsg.post({
      roomId: params.roomId,
      actorId: params.bannedBy,
      systemEvent: SystemEvent.MEMBER_BANNED,
      systemData: { targetUserId: params.targetUserId },
      excludeUserId: params.targetUserId,
    });
    await this.publishRosterChange({
      roomId: params.roomId,
      event: "group:member:removed",
      memberId: params.targetUserId,
      actorId: params.bannedBy,
      extra: { reason: "BAN" },
      excludeUserId: params.targetUserId,
    });

    return updated;
  }

  /**
   * Lift a ban. Actor must be ADMIN/MODERATOR (same gate as `ban`). Does
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
    if (!["ADMIN", "MODERATOR"].includes(actor.role)) {
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
   * Report a member of this group. Goes through the shared {@link publishUserReport}
   * sink — the same admin.report.ingest queue community-service's createReport
   * publishes to, and the same one PrivateRoomService.reportUser uses, so all
   * three surfaces land one identical row shape in admin_db.Report.
   *
   * Authorization mirrors community's report: reporter must be an ACTIVE member,
   * target only needs a member row of ANY status (a banned member can still be
   * reported for prior conduct), no self-report. No role gate — reporting is
   * every member's right, not a moderator power.
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

    publishUserReport({
      context: "GROUP",
      roomId: params.roomId,
      reporterId: params.reporterId,
      targetUserId: params.targetUserId,
      reason: params.reason,
      description: params.description,
    });

    return { ok: true };
  }

  /**
   * Mute/unmute personal notifications for this group — mirrors
   * PrivateRoomService.muteRoom/unmuteRoom. Private already has this; Group had
   * the storage field (`notificationSettings`) and even read it in the inbox
   * list, but no route ever wrote it.
   */
  /**
   * See PrivateRoomService.publishMuteChanged — identical contract, `type` is
   * the only difference. Lives on the single mute/unmute path so the one-off
   * route and the bulk service can never desync a device.
   */
  private publishConversationMuteChanged(
    roomId: string,
    userId: string,
    isMuted: boolean,
    muteUntil: Date | null
  ): void {
    publishChatUserEvent(
      this.redis,
      userId,
      isMuted ? "conv:muted" : "conv:unmuted",
      {
        roomId,
        conversationId: roomId,
        type: "GROUP",
        isMuted,
        mutedUntil: muteUntil ? muteUntil.toISOString() : null,
        updatedAt: Date.now(),
      }
    ).catch((err: unknown) => {
      logger.warn(
        `GroupMemberService|conv:${isMuted ? "muted" : "unmuted"} publish failed room=${roomId} user=${userId}: ${String(err)}`
      );
    });
  }

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
    this.publishConversationMuteChanged(roomId, userId, true, muteUntil);
    return updated ?? member;
  }

  async unmuteRoom(roomId: string, userId: string): Promise<GroupMember> {
    const member = await this.memberRepo.findActiveByRoomAndUser(
      roomId,
      userId
    );
    if (!member) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    const updated = await this.memberRepo.setUnmuted(roomId, userId);
    this.publishConversationMuteChanged(roomId, userId, false, null);
    return updated ?? member;
  }

  async updateRole(params: {
    roomId: string;
    targetUserId: string;
    newRole: string;
    actorUserId: string;
  }): Promise<GroupMember | null> {
    // Parity with muteMember's CHAT_CANNOT_MUTE_SELF — the caller is always
    // the sole ADMIN by the gate below, so a self-target would be either a
    // no-op or (for newRole="ADMIN") a pointless self-handoff.
    if (params.actorUserId === params.targetUserId) {
      throw new BadRequestError("CHAT_CANNOT_CHANGE_OWN_ROLE");
    }

    const actor = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.actorUserId
    );
    if (!actor) throw new NotFoundError("CHAT_NOT_A_MEMBER");
    // Only the sole ADMIN may change roles at all (mirrors community: a
    // MODERATOR can never promote/demote/hand off admin).
    if (actor.role !== "ADMIN") {
      throw new BadRequestError("CHAT_INSUFFICIENT_PERMISSIONS");
    }

    // Captured before the write so the system-message text can distinguish a
    // promotion from a demotion (and an admin hand-off) instead of a
    // generic "role changed to X" line.
    const target = await this.memberRepo.findActiveByRoomAndUser(
      params.roomId,
      params.targetUserId
    );
    if (!target) throw new NotFoundError("CHAT_NOT_A_MEMBER");

    // "Make Admin" — full admin hand-off (this is also what used to be the
    // separate "Transfer Ownership" action; there is exactly one ADMIN per
    // group, so promoting anyone to ADMIN necessarily demotes the caller to
    // MEMBER in the same call). Mirrors community-service's `transferAdmin`.
    if (params.newRole === "ADMIN") {
      await this.memberRepo.updateRole(
        params.roomId,
        params.actorUserId,
        "MEMBER"
      );
      const updated = await this.memberRepo.updateRole(
        params.roomId,
        params.targetUserId,
        "ADMIN"
      );
      await this.sysMsg.post({
        roomId: params.roomId,
        actorId: params.actorUserId,
        systemEvent: SystemEvent.ROLE_CHANGED,
        systemData: {
          targetUserId: params.targetUserId,
          oldRole: target.role,
          newRole: "ADMIN",
        },
      });
      // Two rows changed — the new ADMIN and the demoted-to-MEMBER old admin —
      // so both need their own event or one side's permissions stay stale.
      await this.publishRosterChange({
        roomId: params.roomId,
        event: "group:member:updated",
        memberId: params.targetUserId,
        actorId: params.actorUserId,
        extra: { role: "ADMIN", previousRole: target.role },
      });
      await this.publishRosterChange({
        roomId: params.roomId,
        event: "group:member:updated",
        memberId: params.actorUserId,
        actorId: params.actorUserId,
        extra: { role: "MEMBER", previousRole: "ADMIN" },
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

    // Realtime parity with community's `community:member:updated`: the system
    // message alone only reaches clients currently sitting in the room, so
    // without this the target's own permissions (and every other member's role
    // badge) stay stale on the list view and on their other devices.
    await this.publishRosterChange({
      roomId: params.roomId,
      event: "group:member:updated",
      memberId: params.targetUserId,
      actorId: params.actorUserId,
      extra: { role: params.newRole, previousRole: target?.role ?? "" },
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
    params?: { limit?: number; cursor?: string | null },
    /**
     * Caller, when the roster is served over an authenticated surface. The
     * route had NO membership check at all, so any authenticated user could
     * read any group's roster, and a removed member kept seeing Group Info
     * long after losing the group. Same read rule as the message timeline
     * (`assertGroupReadAccess`): ACTIVE members, voluntary leavers AND removed
     * (kicked) members may read — Group Info stays open read-only after a
     * removal; banned/non-members may not. `findActiveMembers` still returns
     * only the ACTIVE roster, so a removed viewer never sees themselves listed
     * as a member. Optional so the existing internal/test call sites keep
     * compiling unchanged.
     */
    requesterId?: string
  ): Promise<Array<GroupMember | EnrichedGroupMember>> {
    if (requesterId) {
      await assertGroupReadAccess(this.memberRepo, roomId, requesterId);
    }
    return this.enrich(await this.memberRepo.findActiveMembers(roomId, params));
  }

  /** Muted roster — expired mute windows are dropped, matching isGroupMemberMuted. */
  async getMutedMembers(
    roomId: string,
    requesterId: string
  ): Promise<Array<GroupMember | EnrichedGroupMember>> {
    await assertGroupMember(this.memberRepo, roomId, requesterId, {
      roles: ["ADMIN", "MODERATOR"],
    });
    const muted = (await this.memberRepo.findMutedMembers(roomId)).filter(
      isGroupMemberMuted
    );
    return this.enrich(muted);
  }

  private async enrich(
    members: GroupMember[]
  ): Promise<Array<GroupMember | EnrichedGroupMember>> {
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
