import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall, type Breaker } from "@aimess/grpc-utils";
import { logger } from "@aimess/logger";

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
 * Circuit-broken community-service client. Backs the go-live authorization gate.
 *
 * Fail-closed: when the breaker is open / the call errors, we return
 * `{ isMember: false }`. With `STREAM_REQUIRE_MEMBERSHIP=true` that denies
 * go-live rather than letting a non-member through on a community-service
 * outage. The caller (LivestreamService) only consults membership when the env
 * flag is on, so disabling the flag bypasses this client entirely.
 */
export const communityGrpcClient = {
  async validateMembership(
    communityId: string,
    userId: string
  ): Promise<ValidateMembershipResult> {
    try {
      const result = await validateMembershipBreaker.fire({
        communityId,
        userId,
      });
      return {
        isMember: Boolean(result?.isMember),
        role: result?.role ?? "",
        status: result?.status ?? "",
      };
    } catch (error) {
      logger.warn(
        `community.validateMembership failed (fail-closed) for community=${communityId} user=${userId}: ${String(error)}`
      );
      return { isMember: false, role: "", status: "" };
    }
  },
};

export type CommunityGrpcClient = typeof communityGrpcClient;
