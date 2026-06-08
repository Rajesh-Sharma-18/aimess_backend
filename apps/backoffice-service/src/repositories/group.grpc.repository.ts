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
import { msToIso, orNull } from "../lib/grpc-view.js";

/** Map an AdminGroupRow → the list/detail view model. */
function rowToGroupItem(r: RawAdminGroupRow): GroupItem {
  return {
    id: r.id,
    name: r.name,
    avatarUrl: orNull(r.avatarUrl),
    description: r.description ?? "",
    memberCount: r.memberCount,
    createdAt: msToIso(r.createdAt),
    admin: {
      userId: r.admin?.userId ?? "",
      username: r.admin?.username ?? "",
      email: orNull(r.admin?.email),
      avatarUrl: orNull(r.admin?.avatarUrl),
    },
  };
}

/** Map an AdminGroupMemberRow → the members-table view model. */
function rowToMemberItem(r: RawAdminGroupMemberRow): GroupMemberItem {
  return {
    userId: r.userId,
    username: r.username,
    email: orNull(r.email),
    avatarUrl: orNull(r.avatarUrl),
    role: r.role,
    joinedAt: msToIso(r.joinedAt),
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
      items: (res.groups ?? []).map(rowToGroupItem),
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
      items: (res.members ?? []).map(rowToMemberItem),
      pagination: buildPagination(res.total, query.page, query.limit),
    };
  }
}

/** Singleton — mirrors the other repository exports. */
export const groupRepository = new GrpcGroupRepository();
