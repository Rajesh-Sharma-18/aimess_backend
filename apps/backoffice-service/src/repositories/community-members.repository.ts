import {
  communityClient,
  type RawAdminCommunityMemberRow,
} from "../grpc/community.client.js";
import type {
  CommunityMemberRole,
  CommunityMemberRow,
  CommunityMemberStatus,
  ListCommunityMembersQuery,
  Paginated,
  PaginationMeta,
} from "../types/community.types.js";
import { resolveAvatarOrNull } from "../lib/avatar-media.js";

/**
 * Read-through repository for the admin Community Member List (the "Community
 * User List" grid). The member rows are owned by community-service (Mongo) and
 * fully denormalized there, so this repository reaches them ONLY over the
 * community gRPC contract (opossum-wrapped) — never touching Mongo directly.
 * Offset pagination; the avatar arrives already presigned from community-service.
 */
export interface CommunityMembersRepository {
  listMembers(
    communityId: string,
    query: ListCommunityMembersQuery
  ): Promise<Paginated<CommunityMemberRow>>;
}

/** Map a gRPC row → the API-facing member view type. */
async function toRow(
  r: RawAdminCommunityMemberRow
): Promise<CommunityMemberRow> {
  return {
    userId: r.userId,
    username: r.username,
    handle: r.handle,
    // Resolve-on-read defense-in-depth (see community.grpc.repository.ts) —
    // the avatar arrives already presigned from community-service, and
    // resolveAvatarOrNull idempotently passes an already-signed URL through.
    avatar: await resolveAvatarOrNull(r.avatarUrl),
    role: r.role as CommunityMemberRole,
    status: r.status as CommunityMemberStatus,
    // r.joinedAt arrives as an ISO 8601 string from the proto — coerce to epoch ms.
    joinedAt: new Date(r.joinedAt).getTime(),
  };
}

export class GrpcCommunityMembersRepository implements CommunityMembersRepository {
  async listMembers(
    communityId: string,
    query: ListCommunityMembersQuery
  ): Promise<Paginated<CommunityMemberRow>> {
    const { page, limit } = query;

    const { members, total } = await communityClient.adminListCommunityMembers({
      communityId,
      search: query.search ?? "",
      role: query.role ?? "",
      page,
      limit,
      // DB-level exclusion of the viewed user from their own co-member grid;
      // "" = no exclusion. Never filtered in memory (see proto contract).
      excludeUserId: query.excludeUserId ?? "",
      // "username" | "handle" | "joinedAt" | "" (community-service default:
      // role asc then joinedAt asc). Sorting is applied at the DB query level
      // in community-service — never done in memory here.
      sortField: query.sortField ?? "",
      sortDir: query.sortDir ?? "",
    });

    const data = await Promise.all(members.map(toRow));
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    const pagination: PaginationMeta = {
      mode: "offset",
      page,
      limit,
      total,
      totalApprox: total,
      totalPages,
      hasNext: (page - 1) * limit + data.length < total,
      hasPrev: page > 1,
      nextCursor: null,
    };

    return { data, pagination };
  }
}

export const communityMembersRepository: CommunityMembersRepository =
  new GrpcCommunityMembersRepository();
