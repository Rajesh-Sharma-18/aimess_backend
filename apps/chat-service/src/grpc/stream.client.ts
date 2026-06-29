import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/stream.proto"
);

export interface StreamCountsClient {
  /**
   * communityId → LIVE-only stream count. Communities with 0 live streams are
   * omitted. Resolves to an empty map when stream-service is unavailable.
   */
  getActiveStreamCounts(communityIds: string[]): Promise<Map<string, number>>;
}

/**
 * Outbound gRPC client to stream-service for the community rooms-list livestream
 * enrichment (`hasActiveLivestream` / `activeLivestreamCount`). Wrapped in an
 * opossum breaker like the other cross-service clients; fail-open so a
 * stream-service outage degrades to "no live streams", never a 500 on the list.
 */
export function createStreamCountsClient(): StreamCountsClient {
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

  const countsBreaker = makeBreaker(
    "stream.getActiveStreamCountsByCommunityIds",
    (communityIds: string[]) =>
      makeGrpcCall<
        unknown,
        { counts?: { communityId: string; count: number }[] }
      >(client, "getActiveStreamCountsByCommunityIds", { communityIds })
  );
  // Fail-open: stream-service down → every room shows 0 live streams.
  countsBreaker.fallback(() => ({ counts: [] }));

  return {
    getActiveStreamCounts: async (communityIds) => {
      if (!communityIds.length) return new Map();
      try {
        const res = await countsBreaker.fire(communityIds);
        return new Map(
          (res.counts ?? []).map((c) => [c.communityId, Number(c.count ?? 0)])
        );
      } catch (err) {
        logger.warn(
          `stream.getActiveStreamCounts failed; degrading to 0: ${String(err)}`
        );
        return new Map();
      }
    },
  };
}

/** Lazily-created shared stream-counts client (one gRPC channel per process). */
let cached: StreamCountsClient | undefined;
export function getStreamCountsClient(): StreamCountsClient {
  cached ??= createStreamCountsClient();
  return cached;
}
