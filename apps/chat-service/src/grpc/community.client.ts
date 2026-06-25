import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/community.proto"
);

export interface ReconcileMember {
  userId: string;
  status: string; // ACTIVE | PENDING | BANNED | LEFT
  role: string; // ADMIN | MODERATOR | MEMBER
  joinedAt: string; // epoch ms (proto int64 → string under longs:String)
}

export interface ReconcileCommunity {
  id: string;
  name: string;
  adminId: string;
  avatarUrl: string;
  deleted: boolean;
  /** PUBLIC | PRIVATE — drives non-member read access. May be "" on older servers. */
  communityType: string;
  members: ReconcileMember[];
}

export interface ListCommunitiesResult {
  communities: ReconcileCommunity[];
  nextAfterId: string;
  hasMore: boolean;
}

export interface CommunityReconcileClient {
  listCommunities(p: {
    afterId?: string;
    limit?: number;
  }): Promise<ListCommunitiesResult>;
}

/**
 * Outbound gRPC client to community-service's CommunityService.ListCommunities,
 * used only by the boot-time room reconciler. Wrapped in an opossum breaker like
 * the other cross-service clients; a longer timeout than the 2s default since a
 * reconciliation page carries communities + their members.
 */
export function createCommunityReconcileClient(): CommunityReconcileClient {
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

  const listBreaker = makeBreaker(
    "community.listCommunities",
    (p: { afterId?: string; limit?: number }) =>
      call<unknown, ListCommunitiesResult>("listCommunities", {
        afterId: p.afterId ?? "",
        limit: p.limit ?? 0,
      }),
    { timeout: 10_000 }
  );

  return { listCommunities: (p) => listBreaker.fire(p) };
}
