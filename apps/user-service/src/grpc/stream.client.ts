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
  "../../../../packages/grpc-contracts/proto/stream.proto"
);

const pkgDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
const ServiceCtor = (proto["stream"] as grpc.GrpcObject)[
  "StreamService"
] as grpc.ServiceClientConstructor;
const client = new ServiceCtor(
  env.STREAM_GRPC_URL,
  grpc.credentials.createInsecure()
);

const call = <TReq, TRes>(method: string, req: TReq) =>
  makeGrpcCall<TReq, TRes>(client, method, req);

// Best-effort — a stream-service outage must not fail account deletion, whose
// own persistence (softDeleteUser) already completed by the time this fires.
const forceEndByCreatorBreaker = makeBreaker(
  "stream.forceEndStreamsByCreator",
  (args: { creatorId: string; reason: string }) =>
    call<
      { creatorId: string; communityId: string; reason: string },
      { ok?: boolean; endedCount?: number }
    >("forceEndStreamsByCreator", {
      creatorId: args.creatorId,
      communityId: "", // unscoped — account deletion ends every stream everywhere
      reason: args.reason,
    }).then((r) => ({
      ok: r.ok ?? false,
      endedCount: Number(r.endedCount ?? 0),
    }))
);
forceEndByCreatorBreaker.fallback(() => ({ ok: false, endedCount: 0 }));

export const streamGrpcClient = {
  /**
   * Force-ends every non-terminal stream a now-deleted account owns, across
   * every community. Called from the `user.deleted` consumer's handler after
   * the profile itself has already been soft-deleted — a deleted account must
   * not keep broadcasting on a still-valid access token until it expires.
   * Never throws — errors are logged and swallowed so a stream-service outage
   * can't dead-letter (or otherwise fail) the deletion event.
   */
  async forceEndStreamsByCreator(
    creatorId: string,
    reason: string
  ): Promise<void> {
    try {
      await forceEndByCreatorBreaker.fire({ creatorId, reason });
    } catch (err) {
      logger.warn(
        `stream.forceEndStreamsByCreator failed for user=${creatorId}: ${String(err)}`
      );
    }
  },
};
