import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/stream.proto"
);

export interface StreamStatsResult {
  found: boolean;
  status: string;
  viewerCount: number;
  peakViewers: number;
  totalViews: number;
  totalComments: number;
}

export interface AdminUpdateThumbnailResult {
  success: boolean;
}

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

const adminUpdateThumbnailBreaker = makeBreaker(
  "stream.adminUpdateThumbnail",
  (args: { streamId: string; thumbnail: string }) =>
    call<{ streamId: string; thumbnail: string }, AdminUpdateThumbnailResult>(
      "adminUpdateThumbnail",
      args
    ).then((r) => ({ success: r.success ?? false }))
);

const getStreamStatsBreaker = makeBreaker(
  "stream.getStreamStats",
  (args: { streamId: string }) =>
    call<{ streamId: string }, StreamStatsResult>("getStreamStats", args).then(
      (r) => ({
        found: r.found ?? false,
        status: r.status ?? "",
        viewerCount: Number(r.viewerCount ?? 0),
        peakViewers: Number(r.peakViewers ?? 0),
        totalViews: Number(r.totalViews ?? 0),
        totalComments: Number(r.totalComments ?? 0),
      })
    )
);

export const streamClient = {
  async getStreamStats(streamId: string): Promise<StreamStatsResult> {
    try {
      return await getStreamStatsBreaker.fire({ streamId });
    } catch {
      // Fail-open: if stream-service is down, return a "not found" result so
      // the backoffice still serves the mock row without crashing.
      return {
        found: false,
        status: "",
        viewerCount: 0,
        peakViewers: 0,
        totalViews: 0,
        totalComments: 0,
      };
    }
  },

  /** Fail-closed: admin thumbnail update must succeed; propagates on error. */
  async adminUpdateThumbnail(
    streamId: string,
    thumbnail: string
  ): Promise<void> {
    await adminUpdateThumbnailBreaker.fire({ streamId, thumbnail });
  },
};
