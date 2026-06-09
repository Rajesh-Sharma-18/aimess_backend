import type { GroupRoom, GroupMember } from "../generated/prisma/index.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
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
}
export interface AdminGroupMemberRowResult {
  userId: string;
  username: string;
  email: string;
  avatarUrl: string;
  role: string;
  joinedAt: number;
}

export interface AdminListGroupsRequest {
  q?: string;
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
    private readonly authAdminClient: AuthAdminClient
  ) {}

  async listGroups(
    req: AdminListGroupsRequest
  ): Promise<{ groups: AdminGroupRowResult[]; total: number }> {
    let idsFromUserSearch: string[] | null = null;
    const q = req.q?.trim();
    if (q) {
      // Widen search to owner identity: find users matching the term, then the
      // rooms they OWN. Both calls degrade to [] on failure.
      const candidates = await this.authAdminClient.searchUserIds(
        q,
        IDENTITY_SEARCH_CAP
      );
      idsFromUserSearch =
        candidates.length > 0
          ? await this.groupMemberRepo.findRoomIdsByOwnerUserIds(candidates)
          : [];
    }

    const { rows, total } = await this.groupRoomRepo.adminList({
      q,
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

    const groups = rows.map((row) => {
      const ownerId = ownerMap.get(row.roomId) ?? row.createdBy;
      return this.toGroupRow(row, ownerId, snapshots, authMap);
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

    return {
      found: true,
      group: this.toGroupRow(row, ownerId, snapshots, authMap),
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
      userIdsFromSearch = await this.authAdminClient.searchUserIds(
        q,
        IDENTITY_SEARCH_CAP
      );
      if (UUID_RE.test(q)) qExactUserId = q;
    }

    const { rows, total } = await this.groupMemberRepo.adminListMembers({
      roomId: req.groupId,
      role: req.role,
      userIdsFromSearch,
      qExactUserId,
      skip: req.skip,
      take: req.take,
    });

    const userIds = rows.map((m) => m.userId);
    const { snapshots, authMap } = await this.resolveIdentities(userIds);

    const members = rows.map((m) => this.toMemberRow(m, snapshots, authMap));
    return { found: true, members, total };
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

  private toGroupRow(
    row: GroupRoom,
    ownerId: string,
    snapshots: Map<string, Record<string, unknown>>,
    authMap: Map<string, { email: string }>
  ): AdminGroupRowResult {
    const snap = snapshots.get(ownerId);
    return {
      id: row.roomId,
      name: row.name,
      avatarUrl: row.avatar ?? "",
      description: row.description ?? "",
      memberCount: row.memberCount ?? 0,
      createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : 0,
      admin: {
        userId: ownerId,
        username: (snap?.memberId as string) ?? "",
        email: authMap.get(ownerId)?.email ?? "",
        avatarUrl: (snap?.avatar as string) ?? "",
      },
    };
  }

  private toMemberRow(
    m: GroupMember,
    snapshots: Map<string, Record<string, unknown>>,
    authMap: Map<string, { email: string }>
  ): AdminGroupMemberRowResult {
    const snap = snapshots.get(m.userId);
    return {
      userId: m.userId,
      username: (snap?.memberId as string) ?? "",
      email: authMap.get(m.userId)?.email ?? "",
      avatarUrl: (snap?.avatar as string) ?? "",
      role: m.role,
      joinedAt: m.joinedAt instanceof Date ? m.joinedAt.getTime() : 0,
    };
  }
}
