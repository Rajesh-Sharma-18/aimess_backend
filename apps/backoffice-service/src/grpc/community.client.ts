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

// Re-export the row shape so the repository can type its mappers.
export type { RawAdminCommunityRow };

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

export const communityClient = {
  async getCommunityCount(): Promise<number> {
    const r = await getCommunityCountBreaker.fire();
    return Number(r.total);
  },
  adminListCommunities(
    req: AdminListCommunitiesReq
  ): Promise<AdminListCommunitiesRes> {
    return adminListCommunitiesBreaker.fire(req);
  },
  adminGetCommunity(communityId: string): Promise<AdminCommunityDetailRes> {
    return adminGetCommunityBreaker.fire({ communityId });
  },
  adminSetModerationStatus(
    req: AdminSetModerationStatusReq
  ): Promise<AdminSetModerationStatusRes> {
    return adminSetModerationStatusBreaker.fire(req);
  },
};
