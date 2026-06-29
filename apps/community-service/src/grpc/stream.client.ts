import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import type { LiveStreamSummary } from "../types/community.types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/stream.proto"
);

export interface StreamClient {
  getActiveCommunityIds(communityIds: string[]): Promise<Set<string>>;
  /** communityId → LIVE-only stream count. Communities with 0 live streams are omitted. */
  getActiveStreamCounts(communityIds: string[]): Promise<Map<string, number>>;
  getLiveStreamsByCommunity(communityId: string): Promise<LiveStreamSummary[]>;
}

export function createStreamClient(): StreamClient {
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

  const activeIdsBreaker = makeBreaker(
    "stream.getActiveStreamsByCommunityIds",
    (communityIds: string[]) =>
      makeGrpcCall<unknown, { liveCommunityIds?: string[] }>(
        client,
        "getActiveStreamsByCommunityIds",
        { communityIds }
      )
  );
  // Fail-open: if stream-service is down, every community shows isLive=false.
  activeIdsBreaker.fallback(() => ({ liveCommunityIds: [] }));

  const activeCountsBreaker = makeBreaker(
    "stream.getActiveStreamCountsByCommunityIds",
    (communityIds: string[]) =>
      makeGrpcCall<
        unknown,
        { counts?: { communityId: string; count: number }[] }
      >(client, "getActiveStreamCountsByCommunityIds", { communityIds })
  );
  // Fail-open: if stream-service is down, every community shows count 0.
  activeCountsBreaker.fallback(() => ({ counts: [] }));

  const liveStreamsBreaker = makeBreaker(
    "stream.getLiveStreamsByCommunity",
    (communityId: string) =>
      makeGrpcCall<
        unknown,
        {
          streams?: {
            id: string;
            title: string;
            thumbnail: string;
            creatorId: string;
            hlsUrl: string;
            flvUrl: string;
            dashUrl: string;
            viewerCount: string;
            livedAt: string;
          }[];
        }
      >(client, "getLiveStreamsByCommunity", { communityId })
  );
  // Fail-open: if stream-service is down, community detail shows no live streams.
  liveStreamsBreaker.fallback(() => ({ streams: [] }));

  return {
    getActiveCommunityIds: async (communityIds) => {
      if (!communityIds.length) return new Set();
      try {
        const res = await activeIdsBreaker.fire(communityIds);
        return new Set(res.liveCommunityIds ?? []);
      } catch (err) {
        logger.warn(
          `stream.getActiveStreamsByCommunityIds failed; degrading isLive=false: ${String(err)}`
        );
        return new Set();
      }
    },

    getActiveStreamCounts: async (communityIds) => {
      if (!communityIds.length) return new Map();
      try {
        const res = await activeCountsBreaker.fire(communityIds);
        return new Map(
          (res.counts ?? []).map((c) => [c.communityId, Number(c.count ?? 0)])
        );
      } catch (err) {
        logger.warn(
          `stream.getActiveStreamCountsByCommunityIds failed; degrading to 0: ${String(err)}`
        );
        return new Map();
      }
    },

    getLiveStreamsByCommunity: async (communityId) => {
      try {
        const res = await liveStreamsBreaker.fire(communityId);
        return (res.streams ?? []).map((s) => ({
          id: s.id,
          title: s.title,
          thumbnail: s.thumbnail || null,
          creatorId: s.creatorId,
          hlsUrl: s.hlsUrl || null,
          flvUrl: s.flvUrl || null,
          dashUrl: s.dashUrl || null,
          viewerCount: Number(s.viewerCount ?? 0),
          livedAt:
            s.livedAt && Number(s.livedAt) > 0 ? Number(s.livedAt) : null,
        }));
      } catch (err) {
        logger.warn(
          `stream.getLiveStreamsByCommunity failed; degrading to no streams: ${String(err)}`
        );
        return [];
      }
    },
  };
}

/** Lazily-created shared stream client (one gRPC channel per process). */
let cached: StreamClient | undefined;
export function getStreamClient(): StreamClient {
  cached ??= createStreamClient();
  return cached;
}
