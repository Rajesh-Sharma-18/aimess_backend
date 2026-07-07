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
  /**
   * Best-effort push after a moderator mute/unmute: lets any of the target's
   * currently-LIVE stream sessions in this community get a real-time socket
   * notice. Never throws — a stream-service outage must not fail the mute.
   */
  notifyMemberMuteStatus(
    communityId: string,
    userId: string,
    isMuted: boolean,
    mutedUntil: number
  ): Promise<void>;
  /**
   * Best-effort push after an ADMIN bans/unbans a member: lets any of the
   * target's currently-LIVE stream sessions in this community get kicked in
   * real time. Never throws — a stream-service outage must not fail the ban.
   */
  notifyMemberBanStatus(
    communityId: string,
    userId: string,
    isBanned: boolean
  ): Promise<void>;
  /**
   * Best-effort: force-ends every non-terminal stream `userId` owns in THIS
   * community (not their streams in other communities). Called after a
   * community-wide ban or a kick — losing membership means they no longer
   * satisfy the membership gate that let them go live in the first place.
   * Never throws — a stream-service outage must not fail the ban/kick.
   */
  forceEndStreamsByCreator(
    communityId: string,
    userId: string,
    reason: string
  ): Promise<void>;
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

  const notifyMuteBreaker = makeBreaker(
    "stream.notifyMemberMuteStatus",
    (args: {
      communityId: string;
      userId: string;
      isMuted: boolean;
      mutedUntil: number;
    }) =>
      makeGrpcCall<unknown, { ok?: boolean }>(
        client,
        "notifyMemberMuteStatus",
        args
      )
  );
  // Fail-open: a stream-service outage must not fail (or even delay) the mute.
  notifyMuteBreaker.fallback(() => ({ ok: false }));

  const notifyBanBreaker = makeBreaker(
    "stream.notifyMemberBanStatus",
    (args: { communityId: string; userId: string; isBanned: boolean }) =>
      makeGrpcCall<unknown, { ok?: boolean }>(
        client,
        "notifyMemberBanStatus",
        args
      )
  );
  // Fail-open: a stream-service outage must not fail (or even delay) the ban.
  notifyBanBreaker.fallback(() => ({ ok: false }));

  const forceEndBreaker = makeBreaker(
    "stream.forceEndStreamsByCreator",
    (args: { communityId: string; userId: string; reason: string }) =>
      makeGrpcCall<unknown, { ok?: boolean; endedCount?: number }>(
        client,
        "forceEndStreamsByCreator",
        {
          creatorId: args.userId,
          communityId: args.communityId,
          reason: args.reason,
        }
      )
  );
  // Fail-open: a stream-service outage must not fail (or even delay) the ban/kick.
  forceEndBreaker.fallback(() => ({ ok: false, endedCount: 0 }));

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

    notifyMemberMuteStatus: async (
      communityId,
      userId,
      isMuted,
      mutedUntil
    ) => {
      try {
        await notifyMuteBreaker.fire({
          communityId,
          userId,
          isMuted,
          mutedUntil,
        });
      } catch (err) {
        logger.warn(
          `stream.notifyMemberMuteStatus failed for community=${communityId} user=${userId}: ${String(err)}`
        );
      }
    },

    notifyMemberBanStatus: async (communityId, userId, isBanned) => {
      try {
        await notifyBanBreaker.fire({ communityId, userId, isBanned });
      } catch (err) {
        logger.warn(
          `stream.notifyMemberBanStatus failed for community=${communityId} user=${userId}: ${String(err)}`
        );
      }
    },

    forceEndStreamsByCreator: async (communityId, userId, reason) => {
      try {
        await forceEndBreaker.fire({ communityId, userId, reason });
      } catch (err) {
        logger.warn(
          `stream.forceEndStreamsByCreator failed for community=${communityId} user=${userId}: ${String(err)}`
        );
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
