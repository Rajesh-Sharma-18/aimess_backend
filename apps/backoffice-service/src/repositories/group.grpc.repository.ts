import {
  chatClient,
  type AdminListGroupsReq,
  type AdminListGroupMembersReq,
  type RawAdminGroupRow,
  type RawAdminGroupMemberRow,
} from "../grpc/chat.client.js";
import type {
  GroupItem,
  GroupMemberItem,
  GroupPagination,
  ListGroupMembersQuery,
  ListGroupsQuery,
} from "../types/group.types.js";
import { msToEpoch, orNull } from "../lib/grpc-view.js";
import { resolveAvatarOrNull } from "../lib/avatar-media.js";

// Group + user avatars (group logo, owner/member snapshot avatars) live in the
// SHARED avatars bucket. chat-service echoes RAW MinIO object keys for these
// over the AdminGroup* gRPC wire (see admin-group.service.ts toGroupRow /
// toMemberRow), so we resolve-on-read at the backoffice OUTPUT boundary via
// the shared `resolveAvatarOrNull` helper (lib/avatar-media.ts) — the same
// resolver used by every other avatar-bearing admin API, not a duplicate.

/** Map an AdminGroupRow → the list/detail view model. */
async function rowToGroupItem(r: RawAdminGroupRow): Promise<GroupItem> {
  const [avatar, adminAvatar] = await Promise.all([
    resolveAvatarOrNull(r.avatarUrl),
    resolveAvatarOrNull(r.admin?.avatarUrl),
  ]);
  return {
    id: r.id,
    name: r.name,
    avatar,
    description: r.description ?? "",
    memberCount: r.memberCount,
    createdAt: msToEpoch(r.createdAt),
    admin: {
      userId: r.admin?.userId ?? "",
      username: r.admin?.username ?? "",
      email: orNull(r.admin?.email),
      avatar: adminAvatar,
    },
  };
}

/** Map an AdminGroupMemberRow → the members-table view model. */
async function rowToMemberItem(
  r: RawAdminGroupMemberRow
): Promise<GroupMemberItem> {
  return {
    userId: r.userId,
    username: r.username,
    email: orNull(r.email),
    avatar: await resolveAvatarOrNull(r.avatarUrl),
    role: r.role,
    joinedAt: msToEpoch(r.joinedAt),
  };
}

/** Build offset pagination meta from total + the requested page/limit. */
function buildPagination(
  total: number,
  page: number,
  limit: number
): GroupPagination {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page * limit < total,
    hasPrevious: page > 1,
  };
}

/**
 * gRPC-backed Group repository. Pulls group data from chat-service (which owns
 * aimess_chat) over the AdminGroup* RPCs and composes the admin view models.
 * backoffice never touches aimess_chat directly.
 */
export class GrpcGroupRepository {
  async list(
    query: ListGroupsQuery
  ): Promise<{ items: GroupItem[]; pagination: GroupPagination }> {
    const req: AdminListGroupsReq = {
      q: query.q ?? "",
      fromDate: query.fromDate ?? "",
      toDate: query.toDate ?? "",
      sortField: query.sortBy,
      sortDir: query.sortOrder,
      page: query.page,
      limit: query.limit,
    };

    const res = await chatClient.adminListGroups(req);
    return {
      items: await Promise.all((res.groups ?? []).map(rowToGroupItem)),
      pagination: buildPagination(res.total, query.page, query.limit),
    };
  }

  async getById(groupId: string): Promise<GroupItem | null> {
    const res = await chatClient.adminGetGroup(groupId);
    if (!res.found || !res.group) return null;
    return rowToGroupItem(res.group);
  }

  async listMembers(
    groupId: string,
    query: ListGroupMembersQuery
  ): Promise<{
    found: boolean;
    items: GroupMemberItem[];
    pagination: GroupPagination;
  }> {
    const req: AdminListGroupMembersReq = {
      groupId,
      q: query.q ?? "",
      role: query.role ?? "",
      page: query.page,
      limit: query.limit,
    };

    const res = await chatClient.adminListGroupMembers(req);
    return {
      found: res.found,
      items: await Promise.all((res.members ?? []).map(rowToMemberItem)),
      pagination: buildPagination(res.total, query.page, query.limit),
    };
  }
}

/** Singleton — mirrors the other repository exports. */
export const groupRepository = new GrpcGroupRepository();
