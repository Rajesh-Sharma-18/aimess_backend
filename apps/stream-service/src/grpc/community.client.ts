import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall, type Breaker } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/community.proto"
);

interface ValidateMembershipResult {
  isMember: boolean;
  role: string;
  status: string;
}

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

const validateMembershipBreaker: Breaker<
  { communityId: string; userId: string },
  ValidateMembershipResult
> = makeBreaker(
  "community.validateMembership",
  (args: { communityId: string; userId: string }) =>
    call<{ communityId: string; userId: string }, ValidateMembershipResult>(
      "validateMembership",
      args
    )
);

/**
 * Circuit-broken community-service client. Backs the go-live + join gates.
 *
 * Throws on circuit-open / gRPC error — callers decide policy:
 *   - createStream: fail-closed (deny go-live when membership unverifiable)
 *   - checkAccess:  fail-open  (allow viewing so a community-service outage
 *                              doesn't black out all live streams)
 */
export const communityGrpcClient = {
  async validateMembership(
    communityId: string,
    userId: string
  ): Promise<ValidateMembershipResult> {
    const result = await validateMembershipBreaker.fire({
      communityId,
      userId,
    });
    return {
      isMember: Boolean(result?.isMember),
      role: result?.role ?? "",
      status: result?.status ?? "",
    };
  },
};

export type CommunityGrpcClient = typeof communityGrpcClient;
