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
function toRow(r: RawAdminCommunityMemberRow): CommunityMemberRow {
  return {
    userId: r.userId,
    username: r.username,
    handle: r.handle,
    avatarUrl: r.avatarUrl || null,
    role: r.role as CommunityMemberRole,
    status: r.status as CommunityMemberStatus,
    joinedAt: r.joinedAt,
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
    });

    const data = members.map(toRow);
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
