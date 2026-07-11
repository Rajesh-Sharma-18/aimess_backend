import {
  communityClient,
  type RawAdminUserCommunityRow,
} from "../grpc/community.client.js";
import type {
  ListUserCommunitiesQuery,
  Paginated,
  PaginationMeta,
  UserCommunityRow,
} from "../types/community.types.js";
import { resolveCommunityImageOrNull } from "../lib/avatar-media.js";
import { msToEpoch } from "../lib/grpc-view.js";

/**
 * Read-through repository for the admin "Communities" grid on the User
 * Management detail screen — the communities a given user is an ACTIVE member
 * of. The rows are owned by community-service (Mongo) and denormalized there,
 * so this repository reaches them ONLY over the community gRPC contract
 * (opossum-wrapped) — never touching Mongo directly. Offset pagination; the
 * avatar arrives already presigned from community-service.
 */
export interface UserCommunitiesRepository {
  listUserCommunities(
    userId: string,
    query: ListUserCommunitiesQuery
  ): Promise<Paginated<UserCommunityRow>>;
}

/** Map a gRPC row → the API-facing user-community view type. */
async function toRow(r: RawAdminUserCommunityRow): Promise<UserCommunityRow> {
  return {
    communityId: r.communityId,
    name: r.name,
    avatar: await resolveCommunityImageOrNull(r.avatarUrl),
    category: { id: r.categoryId, name: r.categoryName },
    description: r.description,
    memberCount: r.memberCount,
    role: r.role,
    // r.joinedAt arrives as an ISO 8601 string from the proto — coerce to epoch ms.
    joinedAt: new Date(r.joinedAt).getTime(),
    createdAt: msToEpoch(r.createdAt),
  };
}

export class GrpcUserCommunitiesRepository implements UserCommunitiesRepository {
  async listUserCommunities(
    userId: string,
    query: ListUserCommunitiesQuery
  ): Promise<Paginated<UserCommunityRow>> {
    const { page, limit } = query;

    const { communities, total } =
      await communityClient.adminListUserCommunities({
        userId,
        search: query.search ?? "",
        sortField: query.sortField,
        sortDir: query.sortDir,
        page,
        limit,
      });

    const data = await Promise.all(communities.map(toRow));
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

export const userCommunitiesRepository: UserCommunitiesRepository =
  new GrpcUserCommunitiesRepository();
