import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import {
  makeBreaker,
  makeBreakerNoArgs,
  makeGrpcCall,
  type Breaker,
  type NoArgBreaker,
} from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/community.proto"
);

// int64 arrives as a STRING (longs: String) — coerce on read.
interface RawCommunityCount {
  total: string | number;
}

// ---- Backoffice admin RPC raw shapes -------------------------------------
// proto-loader keepCase:false → camelCase; longs:String → int64 as string;
// enums:String → enum values as strings.

/** AdminListCommunitiesRequest (camelCase; "" means "no filter"). */
export interface AdminListCommunitiesReq {
  search: string;
  type: string;
  category: string;
  status: string;
  createdFrom: string;
  createdTo: string;
  sortField: string;
  sortDir: string;
  page: number;
  limit: number;
}

/** AdminCommunityRow — int64 created_at arrives as a string. */
interface RawAdminCommunityRow {
  communityId: string;
  name: string;
  handle: string;
  adminId: string;
  adminName: string;
  adminUsername: string;
  adminAvatarUrl: string;
  type: string;
  categoryId: string;
  categoryName: string;
  categorySlug: string;
  status: string;
  memberCount: number;
  livestreamCount: number;
  createdAt: string;
}

export interface AdminListCommunitiesRes {
  communities: RawAdminCommunityRow[];
  total: number;
}

export interface AdminCommunityDetailRes {
  found: boolean;
  community?: RawAdminCommunityRow;
  description: string;
  coverUrl: string;
  lastActivityAt: string;
  membersTotal: number;
  membersActive: number;
  membersPending: number;
  membersBanned: number;
  membersModerators: number;
  membersJoinedLast7d: number;
  openReports: number;
  activeInviteLinks: number;
  joinPolicy: string;
  ownerEmail: string;
  ownerAccountStatus: string;
}

/** AdminListCommunityMembersRequest (camelCase; "" means "no filter"). */
export interface AdminListCommunityMembersReq {
  communityId: string;
  search: string;
  role: string;
  page: number;
  limit: number;
  // "" = no exclusion. When set, this userId is excluded at the DB level and
  // MUST NEVER appear in the page (hides the viewed user from their own
  // co-member grid). Never filtered in memory.
  excludeUserId: string;
  // "username" | "joinedAt" | "" (default — role asc then joinedAt asc).
  sortField: string;
  // "asc" | "desc" | "" (default asc).
  sortDir: string;
}

/** AdminCommunityMemberRow — avatar already presigned by community-service. */
interface RawAdminCommunityMemberRow {
  userId: string;
  username: string;
  handle: string;
  avatarUrl: string;
  role: string;
  status: string;
  joinedAt: string;
}

// int64 total arrives as a STRING (longs: String) — coerce on read.
export interface AdminListCommunityMembersRes {
  members: RawAdminCommunityMemberRow[];
  total: string | number;
}

/** AdminListUserCommunitiesRequest (camelCase; "" means "no filter"). */
export interface AdminListUserCommunitiesReq {
  userId: string;
  search: string;
  // "name" | "memberCount" | "createdAt" (default createdAt).
  sortField: string;
  // "asc" | "desc" (default desc).
  sortDir: string;
  page: number;
  limit: number;
}

/**
 * AdminUserCommunityRow — avatarUrl already presigned ("" = none); createdAt is
 * an int64 epoch-ms that arrives as a STRING (longs: String).
 */
interface RawAdminUserCommunityRow {
  communityId: string;
  name: string;
  avatarUrl: string;
  categoryId: string;
  categoryName: string;
  description: string;
  memberCount: number;
  role: string;
  joinedAt: string;
  createdAt: string;
}

// int64 total arrives as a STRING (longs: String) — coerce on read.
export interface AdminListUserCommunitiesRes {
  communities: RawAdminUserCommunityRow[];
  total: string | number;
}

/** AdminCommunityBrief — batch enrichment row; avatar already presigned. */
export interface AdminCommunityBrief {
  communityId: string;
  name: string;
  avatarUrl: string;
  categoryId: string;
  categoryName: string;
  categorySlug: string;
  memberCount: number;
}
interface RawAdminGetCommunitiesByIdsRes {
  communities: AdminCommunityBrief[];
}

export interface AdminSetModerationStatusReq {
  communityId: string;
  status: string;
  reasonCode: string;
  actorAdminId: string;
}

export interface AdminSetModerationStatusRes {
  ok: boolean;
  status: string;
  closedAt: string;
  errorCode: string;
}

// ---- Category Management (backoffice admin panel) -------------------------

/** AdminCategoryRow — int64 timestamps arrive as strings (longs: String). */
export interface RawAdminCategoryRow {
  id: string;
  name: string;
  slug: string;
  visible: boolean;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminListCategoriesReq {
  search: string;
  status: string; // "visible" | "hidden" | ""
  page: number;
  limit: number;
  sortField: string; // "name" | "order" | "createdAt" | ""
  sortDir: string; // "asc" | "desc" | ""
}

export interface AdminListCategoriesRes {
  categories: RawAdminCategoryRow[];
  total: string | number;
}

export interface AdminCreateCategoryReq {
  name: string;
}

export interface AdminUpdateCategoryReq {
  categoryId: string;
  name?: string;
  visible?: boolean;
}

export interface AdminCategoryMutationRes {
  ok: boolean;
  category?: RawAdminCategoryRow;
  errorCode: string;
}

export interface AdminDeleteCategoryRes {
  ok: boolean;
  softDeleted: boolean;
  errorCode: string;
}

// Re-export the row shapes so the repositories can type their mappers.
export type {
  RawAdminCommunityRow,
  RawAdminCommunityMemberRow,
  RawAdminUserCommunityRow,
};

const pkgDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
const ServiceCtor = (proto["community"] as grpc.GrpcObject)[
  "CommunityService"
] as grpc.ServiceClientConstructor;
const client = new ServiceCtor(
  env.COMMUNITY_GRPC_URL,
  grpc.credentials.createInsecure()
);

const call = <TReq, TRes>(method: string, req: TReq) =>
  makeGrpcCall<TReq, TRes>(client, method, req);

export const getCommunityCountBreaker: NoArgBreaker<RawCommunityCount> =
  makeBreakerNoArgs("community.getCommunityCount", () =>
    call<unknown, RawCommunityCount>("getCommunityCount", {})
  );

export const adminListCommunitiesBreaker: Breaker<
  AdminListCommunitiesReq,
  AdminListCommunitiesRes
> = makeBreaker(
  "community.adminListCommunities",
  (req: AdminListCommunitiesReq) =>
    call<AdminListCommunitiesReq, AdminListCommunitiesRes>(
      "adminListCommunities",
      req
    )
);

export const adminGetCommunityBreaker: Breaker<
  { communityId: string },
  AdminCommunityDetailRes
> = makeBreaker("community.adminGetCommunity", (req: { communityId: string }) =>
  call<{ communityId: string }, AdminCommunityDetailRes>(
    "adminGetCommunity",
    req
  )
);

export const adminListCommunityMembersBreaker: Breaker<
  AdminListCommunityMembersReq,
  AdminListCommunityMembersRes
> = makeBreaker(
  "community.adminListCommunityMembers",
  (req: AdminListCommunityMembersReq) =>
    call<AdminListCommunityMembersReq, AdminListCommunityMembersRes>(
      "adminListCommunityMembers",
      req
    )
);

export const adminListUserCommunitiesBreaker: Breaker<
  AdminListUserCommunitiesReq,
  AdminListUserCommunitiesRes
> = makeBreaker(
  "community.adminListUserCommunities",
  (req: AdminListUserCommunitiesReq) =>
    call<AdminListUserCommunitiesReq, AdminListUserCommunitiesRes>(
      "adminListUserCommunities",
      req
    )
);

export const adminSetModerationStatusBreaker: Breaker<
  AdminSetModerationStatusReq,
  AdminSetModerationStatusRes
> = makeBreaker(
  "community.adminSetModerationStatus",
  (req: AdminSetModerationStatusReq) =>
    call<AdminSetModerationStatusReq, AdminSetModerationStatusRes>(
      "adminSetModerationStatus",
      req
    )
);

export const adminGetCommunitiesByIdsBreaker: Breaker<
  { communityIds: string[] },
  RawAdminGetCommunitiesByIdsRes
> = makeBreaker(
  "community.adminGetCommunitiesByIds",
  (req: { communityIds: string[] }) =>
    call<{ communityIds: string[] }, RawAdminGetCommunitiesByIdsRes>(
      "adminGetCommunitiesByIds",
      req
    )
);

export const adminListCategoriesBreaker: Breaker<
  AdminListCategoriesReq,
  AdminListCategoriesRes
> = makeBreaker(
  "community.adminListCategories",
  (req: AdminListCategoriesReq) =>
    call<AdminListCategoriesReq, AdminListCategoriesRes>(
      "adminListCategories",
      req
    )
);

export const adminCreateCategoryBreaker: Breaker<
  AdminCreateCategoryReq,
  AdminCategoryMutationRes
> = makeBreaker(
  "community.adminCreateCategory",
  (req: AdminCreateCategoryReq) =>
    call<AdminCreateCategoryReq, AdminCategoryMutationRes>(
      "adminCreateCategory",
      req
    )
);

export const adminUpdateCategoryBreaker: Breaker<
  {
    categoryId: string;
    name: string;
    hasName: boolean;
    visible: boolean;
    hasVisible: boolean;
  },
  AdminCategoryMutationRes
> = makeBreaker(
  "community.adminUpdateCategory",
  (req: {
    categoryId: string;
    name: string;
    hasName: boolean;
    visible: boolean;
    hasVisible: boolean;
  }) => call<typeof req, AdminCategoryMutationRes>("adminUpdateCategory", req)
);

export const adminDeleteCategoryBreaker: Breaker<
  { categoryId: string },
  AdminDeleteCategoryRes
> = makeBreaker(
  "community.adminDeleteCategory",
  (req: { categoryId: string }) =>
    call<{ categoryId: string }, AdminDeleteCategoryRes>(
      "adminDeleteCategory",
      req
    )
);

export const communityClient = {
  async getCommunityCount(): Promise<number> {
    const r = await getCommunityCountBreaker.fire();
    return Number(r.total);
  },
  /**
   * Batch community enrichment for the Livestream Management list/detail.
   * Returns a map keyed by communityId. Empty input → no gRPC call.
   */
  async adminGetCommunitiesByIds(
    communityIds: string[]
  ): Promise<Map<string, AdminCommunityBrief>> {
    if (communityIds.length === 0) return new Map();
    const r = await adminGetCommunitiesByIdsBreaker.fire({ communityIds });
    return new Map((r.communities ?? []).map((c) => [c.communityId, c]));
  },
  adminListCommunities(
    req: AdminListCommunitiesReq
  ): Promise<AdminListCommunitiesRes> {
    return adminListCommunitiesBreaker.fire(req);
  },
  adminGetCommunity(communityId: string): Promise<AdminCommunityDetailRes> {
    return adminGetCommunityBreaker.fire({ communityId });
  },
  async adminListCommunityMembers(
    req: AdminListCommunityMembersReq
  ): Promise<{ members: RawAdminCommunityMemberRow[]; total: number }> {
    const r = await adminListCommunityMembersBreaker.fire(req);
    return { members: r.members, total: Number(r.total) };
  },
  async adminListUserCommunities(
    req: AdminListUserCommunitiesReq
  ): Promise<{ communities: RawAdminUserCommunityRow[]; total: number }> {
    const r = await adminListUserCommunitiesBreaker.fire(req);
    return { communities: r.communities ?? [], total: Number(r.total) };
  },
  adminSetModerationStatus(
    req: AdminSetModerationStatusReq
  ): Promise<AdminSetModerationStatusRes> {
    return adminSetModerationStatusBreaker.fire(req);
  },
  async adminListCategories(
    req: AdminListCategoriesReq
  ): Promise<{ categories: RawAdminCategoryRow[]; total: number }> {
    const r = await adminListCategoriesBreaker.fire(req);
    return { categories: r.categories ?? [], total: Number(r.total) };
  },
  adminCreateCategory(
    req: AdminCreateCategoryReq
  ): Promise<AdminCategoryMutationRes> {
    return adminCreateCategoryBreaker.fire(req);
  },
  adminUpdateCategory(
    req: AdminUpdateCategoryReq
  ): Promise<AdminCategoryMutationRes> {
    return adminUpdateCategoryBreaker.fire({
      categoryId: req.categoryId,
      name: req.name ?? "",
      hasName: req.name !== undefined,
      visible: req.visible ?? false,
      hasVisible: req.visible !== undefined,
    });
  },
  adminDeleteCategory(categoryId: string): Promise<AdminDeleteCategoryRes> {
    return adminDeleteCategoryBreaker.fire({ categoryId });
  },
};
