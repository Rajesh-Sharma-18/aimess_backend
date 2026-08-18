import { logger } from "@aimess/logger";

import { userGrpcClient } from "../grpc/user-snapshot.client.js";
import { isGroupMemberMuted } from "../lib/access-guard.js";
import { resolveMediaUrlMap, urlFromMap } from "../lib/media-resolve.js";

import type { GroupRoom, GroupMember } from "../generated/prisma/index.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import type { GroupRoomService } from "./group-room.service.js";
import type { GroupMemberService } from "./group-member.service.js";
import type { AuthAdminClient } from "../grpc/auth.client.js";

// ---------------------------------------------------------------------------
// Service result shapes (already in proto AdminGroupRow / AdminGroupMemberRow
// camelCase shape; int64 fields are epoch-ms numbers the gRPC layer serializes).
// ---------------------------------------------------------------------------
export interface AdminGroupAdminResult {
  userId: string;
  username: string;
  email: string;
  avatarUrl: string;
}
export interface AdminGroupRowResult {
  id: string;
  name: string;
  avatarUrl: string;
  description: string;
  memberCount: number;
  createdAt: number;
  admin: AdminGroupAdminResult;
  /** Raw lifecycle status: "ACTIVE" | "DISBANDED" | "CLOSED" (owner system-banned). */
  status: string;
  /** Epoch ms; 0 when never disbanded. */
  disbandedAt: number;
}
export interface AdminGroupMemberRowResult {
  userId: string;
  username: string;
  email: string;
  avatarUrl: string;
  role: string;
  joinedAt: number;
  /** "ACTIVE" | "LEFT" | "KICKED" | "BANNED". */
  status: string;
  /** EFFECTIVE mute — timed mutes lazily expire, so never the raw column. */
  moderationMuted: boolean;
  kickedAt: number;
  bannedAt: number;
}

export interface AdminListGroupsRequest {
  q?: string;
  /** "" / "ACTIVE" = active only (default), "ALL" = no filter, else exact. */
  status?: string;
  fromDate?: Date;
  toDate?: Date;
  sortField: "createdAt" | "memberCount";
  sortDir: "asc" | "desc";
  skip: number;
  take: number;
}
export interface AdminListGroupMembersRequest {
  groupId: string;
  q?: string;
  role?: string;
  /** "" / "ACTIVE" = active only (default), "ALL" = no filter, else exact. */
  status?: string;
  skip: number;
  take: number;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Candidate cap for identity (username/email) search. auth-service's
 * AdminListUsers clamps `take` to 100, so asking for more is silently truncated;
 * we request exactly that ceiling so intent matches the wire behaviour. Matches
 * beyond the first 100 identity hits are not reflected in the group/member
 * filter — acceptable for an admin search box at current scale.
 */
const IDENTITY_SEARCH_CAP = 100;

/**
 * Read-side service backing the backoffice Group Management admin RPCs.
 * chat-service OWNS group data (aimess_chat); identity is composed from the
 * batched user-snapshot service (username/avatar) + auth-service (email).
 * Every cross-service identity call degrades gracefully (email → "").
 */
export class AdminGroupService {
  constructor(
    private readonly groupRoomRepo: GroupRoomRepository,
    private readonly groupMemberRepo: GroupMemberRepository,
    private readonly userSnapshotService: UserSnapshotService,
    private readonly cacheRepo: CacheRepository,
    private readonly authAdminClient: AuthAdminClient,
    private readonly groupRoomService: GroupRoomService,
    private readonly groupMemberService: GroupMemberService
  ) {}

  async listGroups(
    req: AdminListGroupsRequest
  ): Promise<{ groups: AdminGroupRowResult[]; total: number }> {
    let idsFromUserSearch: string[] | null = null;
    const q = req.q?.trim();
    if (q) {
      // Widen search to owner identity: find users matching the term, then the
      // rooms they OWN. auth-service matches email/account, user-service matches
      // the username/name the panel actually renders — union both. Each call
      // degrades to [] on failure.
      const [authIds, profileIds] = await Promise.all([
        this.authAdminClient.searchUserIds(q, IDENTITY_SEARCH_CAP),
        userGrpcClient.adminSearchProfileIds(q),
      ]);
      const candidates = [...new Set([...authIds, ...profileIds])];
      idsFromUserSearch =
        candidates.length > 0
          ? await this.groupMemberRepo.findRoomIdsByOwnerUserIds(candidates)
          : [];
    }

    const { rows, total } = await this.groupRoomRepo.adminList({
      q,
      status: req.status,
      idsFromUserSearch,
      fromDate: req.fromDate,
      toDate: req.toDate,
      sortField: req.sortField,
      sortDir: req.sortDir,
      skip: req.skip,
      take: req.take,
    });

    const roomIds = rows.map((r) => r.roomId);
    const ownerMap = await this.groupMemberRepo.findOwnersForRooms(roomIds);
    const ownerIds = rows.map((r) => ownerMap.get(r.roomId) ?? r.createdBy);

    const { snapshots, authMap } = await this.resolveIdentities(ownerIds);
    const urlMap = await this.resolveAvatarUrls(rows, snapshots);

    const groups = rows.map((row) => {
      const ownerId = ownerMap.get(row.roomId) ?? row.createdBy;
      return this.toGroupRow(row, ownerId, snapshots, authMap, urlMap);
    });

    return { groups, total };
  }

  async getGroup(
    groupId: string
  ): Promise<{ found: boolean; group?: AdminGroupRowResult }> {
    const row = await this.groupRoomRepo.adminFindByRoomId(groupId);
    if (!row) return { found: false };

    const ownerMap = await this.groupMemberRepo.findOwnersForRooms([
      row.roomId,
    ]);
    const ownerId = ownerMap.get(row.roomId) ?? row.createdBy;
    const { snapshots, authMap } = await this.resolveIdentities([ownerId]);
    const urlMap = await this.resolveAvatarUrls([row], snapshots);

    return {
      found: true,
      group: this.toGroupRow(row, ownerId, snapshots, authMap, urlMap),
    };
  }

  async listGroupMembers(req: AdminListGroupMembersRequest): Promise<{
    found: boolean;
    members: AdminGroupMemberRowResult[];
    total: number;
  }> {
    const room = await this.groupRoomRepo.adminFindByRoomId(req.groupId);
    if (!room) return { found: false, members: [], total: 0 };

    let userIdsFromSearch: string[] | null = null;
    let qExactUserId: string | null = null;
    const q = req.q?.trim();
    if (q) {
      // Same email/account + username/name union as listGroups above.
      const [authIds, profileIds] = await Promise.all([
        this.authAdminClient.searchUserIds(q, IDENTITY_SEARCH_CAP),
        userGrpcClient.adminSearchProfileIds(q),
      ]);
      userIdsFromSearch = [...new Set([...authIds, ...profileIds])];
      if (UUID_RE.test(q)) qExactUserId = q;
    }

    const { rows, total } = await this.groupMemberRepo.adminListMembers({
      roomId: req.groupId,
      role: req.role,
      status: req.status,
      userIdsFromSearch,
      qExactUserId,
      skip: req.skip,
      take: req.take,
    });

    const userIds = rows.map((m) => m.userId);
    const { snapshots, authMap } = await this.resolveIdentities(userIds);
    // Members carry only user-avatar snapshots (no group-logo row) — resolve them.
    const urlMap = await this.resolveAvatarUrls([], snapshots);

    const members = rows.map((m) =>
      this.toMemberRow(m, snapshots, authMap, urlMap)
    );
    return { found: true, members, total };
  }

  /**
   * Platform-admin disband. Delegates to the normal GroupRoomService write path
   * (which also revokes live invite links) with the member/role check bypassed;
   * `actorAdminId` is a backoffice AdminUser.id, stored as disbandedBy only.
   * Failure states are RETURNED as codes, never thrown — the panel localizes them.
   */
  async disbandGroup(
    groupId: string,
    actorAdminId: string
  ): Promise<{ ok: boolean; found: boolean; errorCode: string }> {
    const row = await this.groupRoomRepo.adminFindByRoomId(groupId);
    if (!row)
      return { ok: false, found: false, errorCode: "CHAT_GROUP_NOT_FOUND" };
    if (row.status !== "ACTIVE")
      return {
        ok: false,
        found: true,
        errorCode: "CHAT_GROUP_ALREADY_DISBANDED",
      };

    await this.groupRoomService.disbandGroup(groupId, actorAdminId, {
      asPlatformAdmin: true,
    });
    return { ok: true, found: true, errorCode: "" };
  }

  /**
   * Platform-admin member removal. Delegates to GroupMemberService.kick so the
   * removed user is actually evicted (`group:removed`) and every other member's
   * roster updates — a bare repository write would leave both stale.
   */
  async removeGroupMember(params: {
    groupId: string;
    userId: string;
    actorAdminId: string;
    reason?: string;
  }): Promise<{ ok: boolean; found: boolean; errorCode: string }> {
    const row = await this.groupRoomRepo.adminFindByRoomId(params.groupId);
    if (!row)
      return { ok: false, found: false, errorCode: "CHAT_GROUP_NOT_FOUND" };

    const member = await this.groupMemberRepo.findActiveByRoomAndUser(
      params.groupId,
      params.userId
    );
    if (!member)
      return { ok: false, found: true, errorCode: "CHAT_NOT_A_MEMBER" };

    await this.groupMemberService.kick({
      roomId: params.groupId,
      targetUserId: params.userId,
      kickedBy: params.actorAdminId,
      reason: params.reason,
      asPlatformAdmin: true,
    });
    return { ok: true, found: true, errorCode: "" };
  }

  /**
   * Group-side cascade of a PERMANENT super-admin system ban.
   *
   * Groups the user OWNS are CLOSED, not disbanded: a disband ends every
   * membership and hides the room, punishing the members for the owner's ban —
   * a close leaves the roster intact so the group stays in everyone's list,
   * readable, write-refused, with a banner. Every OTHER membership is ended
   * through the normal kick path so the user is evicted from those rooms and
   * their rosters update live.
   *
   * Ownership is the `role: "ADMIN"` membership row, never `GroupRoom.createdBy`
   * — the creator can have transferred ownership or left long ago.
   *
   * Log-and-continue per room: one bad room must not strand the rest of the
   * ban, which the caller has already applied to the account itself.
   */
  async adminApplySystemBan(
    userId: string,
    actorAdminId: string,
    _reason?: string
  ): Promise<{ closedGroupIds: string[]; removedGroupIds: string[] }> {
    const closedGroupIds: string[] = [];
    const removedGroupIds: string[] = [];
    if (!userId) return { closedGroupIds, removedGroupIds };

    const ownedRoomIds = await this.groupMemberRepo.findRoomIdsByOwnerUserIds([
      userId,
    ]);
    const owned = new Set(ownedRoomIds);

    for (const roomId of ownedRoomIds) {
      try {
        // Returns null when the room is not ACTIVE — already closed by a
        // previous run, or disbanded. Both are a no-op, so this is idempotent.
        const closed = await this.groupRoomService.closeGroupForSystemBan(
          roomId,
          actorAdminId
        );
        if (closed) closedGroupIds.push(roomId);
      } catch (err) {
        logger.error(
          `AdminGroupService|adminApplySystemBan|close failed room=${roomId} user=${userId}: ${String(err)}`
        );
      }
    }

    const memberships = await this.groupMemberRepo.getActiveRoomIds(userId);
    for (const roomId of memberships) {
      if (owned.has(roomId)) continue;
      try {
        await this.groupMemberService.kick({
          roomId,
          targetUserId: userId,
          kickedBy: actorAdminId,
          reason: "ACCOUNT_BANNED",
          asPlatformAdmin: true,
        });
        removedGroupIds.push(roomId);
      } catch (err) {
        logger.error(
          `AdminGroupService|adminApplySystemBan|remove failed room=${roomId} user=${userId}: ${String(err)}`
        );
      }
    }

    logger.info(
      `AdminGroupService|adminApplySystemBan|user=${userId} closed=${closedGroupIds.length} removed=${removedGroupIds.length}`
    );
    return { closedGroupIds, removedGroupIds };
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------

  /** Batch snapshots (username/avatar) + auth emails for a set of user ids. */
  private async resolveIdentities(userIds: string[]): Promise<{
    snapshots: Map<string, Record<string, unknown>>;
    authMap: Map<string, { email: string }>;
  }> {
    const ids = [...new Set(userIds.filter(Boolean))];
    const [snapshots, authMap] = await Promise.all([
      this.userSnapshotService.getUserSnapshotsMap(ids, this.cacheRepo),
      this.authAdminClient.resolveUsersByIds(ids),
    ]);
    return { snapshots, authMap };
  }

  /**
   * Batch-resolve every avatar object key across a set of group rows (the group
   * logo `row.avatar`) and owner/member snapshots (`snap.avatar`) to download
   * URLs in ONE deduped presign pass. Pass the returned map to {@link toGroupRow}
   * / {@link toMemberRow} so each row stamps a usable URL synchronously instead
   * of leaking a raw object key over the admin gRPC surface.
   */
  private resolveAvatarUrls(
    rows: GroupRoom[],
    snapshots: Map<string, Record<string, unknown>>
  ): Promise<Map<string, string>> {
    const keys: string[] = [];
    for (const row of rows) if (row.avatar) keys.push(row.avatar);
    for (const snap of snapshots.values()) {
      const avatar = snap.avatar;
      if (typeof avatar === "string" && avatar) keys.push(avatar);
    }
    return resolveMediaUrlMap(keys);
  }

  private toGroupRow(
    row: GroupRoom,
    ownerId: string,
    snapshots: Map<string, Record<string, unknown>>,
    authMap: Map<string, { email: string }>,
    urlMap: Map<string, string>
  ): AdminGroupRowResult {
    const snap = snapshots.get(ownerId);
    return {
      id: row.roomId,
      name: row.name,
      avatarUrl: urlFromMap(urlMap, row.avatar ?? ""),
      description: row.description ?? "",
      memberCount: row.memberCount ?? 0,
      createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : 0,
      admin: {
        userId: ownerId,
        username: (snap?.memberId as string) ?? "",
        email: authMap.get(ownerId)?.email ?? "",
        avatarUrl: urlFromMap(urlMap, (snap?.avatar as string) ?? ""),
      },
      status: row.status,
      disbandedAt:
        row.disbandedAt instanceof Date ? row.disbandedAt.getTime() : 0,
    };
  }

  private toMemberRow(
    m: GroupMember,
    snapshots: Map<string, Record<string, unknown>>,
    authMap: Map<string, { email: string }>,
    urlMap: Map<string, string>
  ): AdminGroupMemberRowResult {
    const snap = snapshots.get(m.userId);
    return {
      userId: m.userId,
      username: (snap?.memberId as string) ?? "",
      email: authMap.get(m.userId)?.email ?? "",
      avatarUrl: urlFromMap(urlMap, (snap?.avatar as string) ?? ""),
      role: m.role,
      joinedAt: m.joinedAt instanceof Date ? m.joinedAt.getTime() : 0,
      status: m.status,
      // Effective, not raw: a timed mute lifts the instant it passes while the
      // column stays true until the sweeper runs (up to a minute later).
      moderationMuted: isGroupMemberMuted(m),
      kickedAt: m.kickedAt instanceof Date ? m.kickedAt.getTime() : 0,
      bannedAt: m.bannedAt instanceof Date ? m.bannedAt.getTime() : 0,
    };
  }
}
