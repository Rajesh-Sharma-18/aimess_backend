import { logger } from "@aimess/logger";

import { userGrpcClient } from "../grpc/user-snapshot.client.js";
import { resolveMediaUrlMap, urlFromMap } from "../lib/media-resolve.js";

import type {
  GroupRoom,
  GroupMember,
  GroupClosureMember,
} from "../generated/prisma/index.js";
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
  /** Owner's ACCOUNT status from auth ("ACTIVE" | "SUSPENDED" | "BANNED" | ""). */
  ownerAccountStatus: string;
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
  /** "ACTIVE" | "LEFT" | "KICKED" (a stale BANNED row reads as KICKED). */
  status: string;
  /** Always false: groups have no moderation mute (kept for the proto shape). */
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
  excludeUserId?: string;
  skip: number;
  take: number;
}
export interface AdminListUserGroupsRequest {
  userId: string;
  skip: number;
  take: number;
}
export interface AdminUserGroupRowResult {
  id: string;
  name: string;
  avatarUrl: string;
  description: string;
  memberCount: number;
  memberLimit: number;
  createdAt: number;
  status: string;
  role: string;
  joinedAt: number;
}

/**
 * Roster size frozen when the group left ACTIVE, or null when the live roster
 * applies (ACTIVE group, or a legacy closed group with no snapshot).
 */
function closureCount(row: GroupRoom): number | null {
  return row.status !== "ACTIVE" && row.memberCountAtClosure != null
    ? row.memberCountAtClosure
    : null;
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
    // Denormalized row.memberCount drifts (counts LEFT/KICKED members); count
    // the live ACTIVE roster per room in one batched query so the
    // list Members column matches the detail header and the roster list.
    const memberCountMap =
      await this.groupMemberRepo.countRosterMembersForRooms(roomIds);

    const { snapshots, authMap } = await this.resolveIdentities(ownerIds);
    const urlMap = await this.resolveAvatarUrls(rows, snapshots);

    const groups = rows.map((row) => {
      const ownerId = ownerMap.get(row.roomId) ?? row.createdBy;
      const group = this.toGroupRow(row, ownerId, snapshots, authMap, urlMap);
      group.memberCount =
        closureCount(row) ?? memberCountMap.get(row.roomId) ?? 0;
      return group;
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

    const group = this.toGroupRow(row, ownerId, snapshots, authMap, urlMap);
    // Denormalized row.memberCount drifts (counts LEFT/KICKED members); the
    // detail header must match the roster list, so report the live count —
    // or, for a closed group, the roster frozen at closure.
    group.memberCount =
      closureCount(row) ??
      (await this.groupMemberRepo.countRosterMembers(row.roomId));

    return { found: true, group };
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

    // A closed group lists the roster frozen at closure, never the live rows
    // (a disband ends every membership; later leave/kick/ban must not matter).
    if (closureCount(room) !== null) {
      const snap = await this.groupMemberRepo.adminListClosureMembers({
        roomId: req.groupId,
        role: req.role,
        status: req.status,
        q,
        userIdsFromSearch,
        qExactUserId,
        excludeUserId: req.excludeUserId,
        skip: req.skip,
        take: req.take,
      });
      return {
        found: true,
        members: await this.toClosureMemberRows(snap.rows),
        total: snap.total,
      };
    }

    const { rows, total } = await this.groupMemberRepo.adminListMembers({
      roomId: req.groupId,
      role: req.role,
      status: req.status,
      userIdsFromSearch,
      qExactUserId,
      excludeUserId: req.excludeUserId,
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

  async listUserGroups(
    req: AdminListUserGroupsRequest
  ): Promise<{ groups: AdminUserGroupRowResult[]; total: number }> {
    const memberships = await this.groupMemberRepo.getActiveMemberships(
      req.userId
    );
    if (!memberships.length) return { groups: [], total: 0 };

    const membershipByRoom = new Map(memberships.map((m) => [m.roomId, m]));
    const roomIds = [...membershipByRoom.keys()];
    const [rows, total] = await Promise.all([
      this.groupRoomRepo.searchInRoomIds(roomIds, undefined, req.take, req.skip),
      this.groupRoomRepo.countUserGroups(roomIds),
    ]);

    const [memberCountMap, urlMap] = await Promise.all([
      this.groupMemberRepo.countRosterMembersForRooms(
        rows.map((r) => r.roomId)
      ),
      this.resolveAvatarUrls(rows, new Map()),
    ]);

    const groups = rows.map((row) => {
      const membership = membershipByRoom.get(row.roomId);
      return {
        id: row.roomId,
        name: row.name,
        avatarUrl: urlFromMap(urlMap, row.avatar ?? ""),
        description: row.description ?? "",
        memberCount:
          closureCount(row) ?? memberCountMap.get(row.roomId) ?? 0,
        memberLimit: row.memberLimit,
        createdAt: row.createdAt.getTime(),
        status: row.status,
        role: membership?.role ?? "MEMBER",
        joinedAt: membership?.joinedAt.getTime() ?? 0,
      };
    });

    return { groups, total };
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
    // Removing the leader hands the group over first, so it never goes headless.
    if (member.role === "ADMIN") {
      await this.groupMemberService.autoSucceed(params.groupId, params.userId);
    }

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
   * Legacy platform-admin GROUP ban. Groups have no ban: it is a removal
   * (KICKED, re-addable by the leader) with the "AI Mess Administrator removed X"
   * line. The response shape is kept; `closedGroup` is always false.
   */
  async banGroupMember(params: {
    groupId: string;
    userId: string;
    actorAdminId: string;
    reason?: string;
  }): Promise<{
    ok: boolean;
    found: boolean;
    errorCode: string;
    closedGroup: boolean;
  }> {
    const row = await this.groupRoomRepo.adminFindByRoomId(params.groupId);
    if (row && row.status !== "ACTIVE")
      return {
        ok: false,
        found: true,
        errorCode: "CHAT_GROUP_NOT_ACTIVE",
        closedGroup: false,
      };
    return { ...(await this.removeGroupMember(params)), closedGroup: false };
  }

  /** Legacy platform-admin GROUP unban: nothing to lift any more, so a no-op success. */
  async unbanGroupMember(params: {
    groupId: string;
    userId: string;
    actorAdminId: string;
  }): Promise<{ ok: boolean; found: boolean; errorCode: string }> {
    const row = await this.groupRoomRepo.adminFindByRoomId(params.groupId);
    if (!row)
      return { ok: false, found: false, errorCode: "CHAT_GROUP_NOT_FOUND" };
    return { ok: true, found: true, errorCode: "" };
  }

  /**
   * Group-side cascade of a super-admin system ban (or suspension).
   *
   * Groups the user LEADS pass to their longest-standing member. Only a group
   * with nobody left to promote is CLOSED (never disbanded), as before. Every
   * OTHER membership is kept; `removedGroupIds` stays in the wire shape and is
   * always empty.
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

    const orphanedRoomIds =
      await this.groupMemberService.autoSucceedEverywhere(userId);

    for (const roomId of orphanedRoomIds) {
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

    // Every OTHER membership is deliberately left ACTIVE: the banned account
    // stays on the roster as an unavailable member (profile closed, admins may
    // only Remove), and an unban restores it with nothing to rebuild. The ban
    // flag + revoked sessions already refuse every read and write.

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
    authMap: Map<string, { email: string; status: string }>;
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
    authMap: Map<string, { email: string; status: string }>,
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
      ownerAccountStatus: authMap.get(ownerId)?.status ?? "",
      disbandedAt:
        row.disbandedAt instanceof Date ? row.disbandedAt.getTime() : 0,
    };
  }

  /**
   * Closure-snapshot rows → member rows. Identity comes from the snapshot (the
   * name/avatar the group knew at closure); only a blank snapshot (lookup
   * failed at closure time) falls back to the live identity.
   */
  private async toClosureMemberRows(
    rows: GroupClosureMember[]
  ): Promise<AdminGroupMemberRowResult[]> {
    const { snapshots, authMap } = await this.resolveIdentities(
      rows.map((r) => r.userId)
    );
    const keys = rows.map(
      (r) => r.avatar || ((snapshots.get(r.userId)?.avatar as string) ?? "")
    );
    const urlMap = await resolveMediaUrlMap(keys.filter(Boolean));
    return rows.map((r, i) => {
      const live = snapshots.get(r.userId);
      return {
        userId: r.userId,
        username:
          r.username || r.displayName || ((live?.memberId as string) ?? ""),
        email: authMap.get(r.userId)?.email ?? "",
        avatarUrl: urlFromMap(urlMap, keys[i] ?? ""),
        role: r.role,
        joinedAt: r.joinedAt.getTime(),
        status: r.status,
        moderationMuted: false,
        kickedAt: 0,
        bannedAt: r.bannedAt ? r.bannedAt.getTime() : 0,
      };
    });
  }

  private toMemberRow(
    m: GroupMember,
    snapshots: Map<string, Record<string, unknown>>,
    authMap: Map<string, { email: string; status: string }>,
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
      moderationMuted: false,
      kickedAt: m.kickedAt instanceof Date ? m.kickedAt.getTime() : 0,
      bannedAt: m.bannedAt instanceof Date ? m.bannedAt.getTime() : 0,
    };
  }
}
