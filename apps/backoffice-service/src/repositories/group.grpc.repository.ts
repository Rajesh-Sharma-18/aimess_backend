import { ConflictError, NotFoundError } from "@aimess/errors";

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
// SHARED avatars bucket. chat-service ALREADY resolves these to presigned URLs
// on its AdminGroup* RPCs (admin-group.service.ts toGroupRow / toMemberRow via
// resolveMediaUrlMap); backoffice resolves AGAIN at its own OUTPUT boundary as
// defense-in-depth — the shared `resolveAvatarOrNull` (lib/avatar-media.ts)
// re-derives the object key and re-signs against backoffice's public endpoint
// and expiry, so the response carries a real objectKey/fileId and can never
// leak a raw key if an upstream path regresses. Presign is a local HMAC (no
// I/O). Presigned URLs expire — never persist them.

// int64-as-string → epoch ms, or null for "never" (chat-service sends 0) and
// for an absent proto field (msToEpoch → NaN).
function epochOrNull(v: string | undefined): number | null {
  const t = msToEpoch(v ?? 0);
  return t > 0 ? t : null;
}

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
    status: r.status || "ACTIVE",
    disbandedAt: epochOrNull(r.disbandedAt),
    lastMessageAt: epochOrNull(r.lastMessageAt),
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
    status: r.status || "ACTIVE",
    kickedAt: epochOrNull(r.kickedAt),
    bannedAt: epochOrNull(r.bannedAt),
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

// Map a business error_code from the AdminGroup* moderation RPCs → the same
// error types the rest of backoffice throws. chat-service can emit exactly:
// CHAT_GROUP_NOT_FOUND (both RPCs), CHAT_GROUP_ALREADY_DISBANDED (disband),
// CHAT_NOT_A_MEMBER (remove-member). The not-found case reuses the controller's
// existing GROUP_NOT_FOUND client code so 404s stay one code across the vertical;
// the rest are 409 conflicts carrying the raw chat code.
function mapGroupModerationError(errorCode: string): Error {
  if (errorCode === "CHAT_GROUP_NOT_FOUND") {
    return new NotFoundError("GROUP_NOT_FOUND");
  }
  // CHAT_NOT_A_MEMBER is a localized END-USER key in @aimess/constants, so the
  // error handler would render it as "You are not a member of this group" —
  // addressed to the platform admin, who was never a member. Re-code it so the
  // panel gets an admin-scoped string instead of that wrong sentence.
  if (errorCode === "CHAT_NOT_A_MEMBER") {
    return new ConflictError("GROUP_MEMBER_NOT_ACTIVE");
  }
  return new ConflictError(errorCode);
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
      status: query.status ?? "",
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
      status: query.status ?? "",
    };

    const res = await chatClient.adminListGroupMembers(req);
    return {
      found: res.found,
      items: await Promise.all((res.members ?? []).map(rowToMemberItem)),
      pagination: buildPagination(res.total, query.page, query.limit),
    };
  }

  // Platform-admin disband. Throws on every business failure; void on success.
  async disband(groupId: string, actorAdminId: string): Promise<void> {
    const res = await chatClient.adminDisbandGroup({ groupId, actorAdminId });
    if (res.errorCode) throw mapGroupModerationError(res.errorCode);
  }

  // Platform-admin member removal. Throws on every business failure; void on success.
  async removeMember(
    groupId: string,
    userId: string,
    actorAdminId: string,
    reason?: string
  ): Promise<void> {
    const res = await chatClient.adminRemoveGroupMember({
      groupId,
      userId,
      actorAdminId,
      reason: reason ?? "",
    });
    if (res.errorCode) throw mapGroupModerationError(res.errorCode);
  }
}

/** Singleton — mirrors the other repository exports. */
export const groupRepository = new GrpcGroupRepository();
