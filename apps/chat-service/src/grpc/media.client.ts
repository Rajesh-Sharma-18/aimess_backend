/**
 * Outbound gRPC client to media-service, used to verify an attachment BEFORE the
 * message that references it is persisted.
 *
 * Why chat-service needs this at all:
 *
 * media-service owns the upload security pipeline, and its scan gate lives
 * inside `generateDownloadUrl`. chat-service never calls that — `lib/media-resolve.ts`
 * presigns MinIO directly on every read, which is the right design for latency
 * but means the gate is simply not on chat's path. Combined with send-time
 * validation that only ever looked at CLIENT-SUPPLIED `size` and `mime`, an
 * attachment reached every member of a room without anything having verified
 * that the object exists, that the sender uploaded it, that it belongs to that
 * room, or that it passed a scan.
 *
 * Verifying at WRITE time rather than read time is deliberate: it is one call
 * per send instead of one per read, and an object that never becomes a persisted
 * reference cannot be served by any read path — including ones added later.
 *
 * FAIL-CLOSED. Unlike the friendship and livestream-count clients (which degrade
 * to a permissive default because a false "no" is a worse product outcome than a
 * false "yes"), an inconclusive answer here means "we do not know whether this
 * file is safe". The send is rejected with a retryable error.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { makeGrpcCallWithDeadline } from "@aimess/grpc-utils";

import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/media.proto"
);

/** Bound on the send path — a slow media-service must not hang a message send. */
const CHECK_DEADLINE_MS = 3_000;

export interface MediaStatusEntry {
  objectKey: string;
  scanStatus: string;
  downloadable: boolean;
  ownerId: string;
  resourceId: string;
  contentType: string;
  size: number;
}

export interface MediaVerifyClient {
  /**
   * Resolve the verdict for each key. Throws when media-service cannot be
   * reached — callers must treat that as "unverified", never as "fine".
   */
  checkMediaStatus(
    objectKeys: string[]
  ): Promise<Map<string, MediaStatusEntry>>;
}

export function createMediaVerifyClient(): MediaVerifyClient {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const ServiceCtor = (proto["media"] as grpc.GrpcObject)[
    "MediaService"
  ] as grpc.ServiceClientConstructor;
  const client = new ServiceCtor(
    env.MEDIA_GRPC_URL,
    grpc.credentials.createInsecure()
  );

  return {
    async checkMediaStatus(objectKeys) {
      const out = new Map<string, MediaStatusEntry>();
      if (objectKeys.length === 0) return out;

      const res = await makeGrpcCallWithDeadline<
        { objectKeys: string[] },
        { entries?: Array<Record<string, unknown>> }
      >(
        client,
        "checkMediaStatus",
        { objectKeys },
        Date.now() + CHECK_DEADLINE_MS
      );

      for (const raw of res.entries ?? []) {
        const objectKey = String(raw.objectKey ?? "");
        if (!objectKey) continue;
        out.set(objectKey, {
          objectKey,
          scanStatus: String(raw.scanStatus ?? ""),
          downloadable: Boolean(raw.downloadable),
          ownerId: String(raw.ownerId ?? ""),
          resourceId: String(raw.resourceId ?? ""),
          contentType: String(raw.contentType ?? ""),
          size: Number(raw.size ?? 0),
        });
      }
      return out;
    },
  };
}

let cached: MediaVerifyClient | undefined;
export function getMediaVerifyClient(): MediaVerifyClient {
  cached ??= createMediaVerifyClient();
  return cached;
}

/** Test seam — lets the E2E harness inject a stub without a live media-service. */
export function setMediaVerifyClient(
  stub: MediaVerifyClient | undefined
): void {
  cached = stub;
}
