import {
  communityClient,
  type RawAdminMutedMemberRow,
} from "../grpc/community.client.js";
import type {
  CommunityMutedMemberRow,
  ListMutedMembersQuery,
  Paginated,
  PaginationMeta,
} from "../types/community.types.js";

/**
 * Read-through repository for the admin Muted-Members list — a platform-admin
 * view of a community's moderation mutes. The mute rows are owned by
 * community-service (Mongo), so this repository reaches them ONLY over the
 * community gRPC contract (opossum-wrapped) — never touching Mongo directly.
 * Offset pagination; the avatar arrives already presigned from community-service.
 */
export interface CommunityMutesRepository {
  listMutedMembers(
    communityId: string,
    query: ListMutedMembersQuery
  ): Promise<Paginated<CommunityMutedMemberRow>>;
}

/** Map a gRPC row → the API-facing muted-member view type. */
function toRow(r: RawAdminMutedMemberRow): CommunityMutedMemberRow {
  const mutedUntil = Number(r.mutedUntil);
  return {
    userId: r.userId,
    username: r.username,
    handle: r.handle,
    avatarUrl: r.avatarUrl || null,
    mutedBy: r.mutedBy,
    reason: r.reason || null,
    mutedAt: new Date(Number(r.mutedAt)).toISOString(),
    mutedUntil: mutedUntil > 0 ? new Date(mutedUntil).toISOString() : null,
  };
}

export class GrpcCommunityMutesRepository implements CommunityMutesRepository {
  async listMutedMembers(
    communityId: string,
    query: ListMutedMembersQuery
  ): Promise<Paginated<CommunityMutedMemberRow>> {
    const { page, limit } = query;

    const { members, total } = await communityClient.adminListMutedMembers({
      communityId,
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

export const communityMutesRepository: CommunityMutesRepository =
  new GrpcCommunityMutesRepository();
