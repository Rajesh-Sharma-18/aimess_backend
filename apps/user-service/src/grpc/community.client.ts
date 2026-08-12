import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { logger } from "@aimess/logger";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/community.proto"
);

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

const activeMemberIdsBreaker = makeBreaker(
  "community.getCommunityActiveMemberIds",
  (communityId: string) =>
    makeGrpcCall<{ communityId: string }, { userIds?: string[] }>(
      client,
      "getCommunityActiveMemberIds",
      { communityId }
    ).then((r) => r.userIds ?? [])
);
// Fail OPEN (empty roster = exclude nobody). This list only narrows an "Add
// Members" picker; a community-service outage must degrade to "shows everyone,
// the add call still rejects duplicates", never to "shows nobody".
activeMemberIdsBreaker.fallback(() => [] as string[]);

export const communityGrpcClient = {
  /**
   * Every ACTIVE member of a community. Used to subtract the existing roster
   * from the friend picker so an already-added member can't be selected again.
   * Never throws.
   */
  async getActiveMemberIds(communityId: string): Promise<string[]> {
    if (!communityId) return [];
    try {
      return await activeMemberIdsBreaker.fire(communityId);
    } catch (err) {
      logger.warn(
        `community.getCommunityActiveMemberIds failed: ${String(err)}`
      );
      return [];
    }
  },
};
