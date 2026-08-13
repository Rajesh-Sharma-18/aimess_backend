/**
 * Outbound gRPC client to media-service, used to verify an avatar object BEFORE
 * it is persisted on a profile.
 *
 * Why user-service needs this: `USER_AVATAR` uploads are minted by media-service
 * into the same bucket and `avatars/` prefix that this service trusts, but
 * `/media/confirm` is CLIENT-DRIVEN. A client could request an upload URL, PUT
 * arbitrary bytes, skip confirm entirely, and PATCH the key onto its profile —
 * `resolveAvatarObjectKeyForProfile` checked only existence, size and key
 * ownership. And because this service presigns its own GET
 * (`avatar.service.ts#resolveViewUrlForClient`) rather than calling
 * `/media/download-url`, media-service's scan gate never saw the object on the
 * way out either. The result was an unscanned file served to every consumer of
 * that profile — search results, friend lists, chat notification enrichment.
 *
 * FAIL CLOSED: an unreachable media-service rejects the profile update with a
 * retryable 503 rather than persisting an unverified key.
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

const CHECK_DEADLINE_MS = 3_000;

export interface MediaVerdict {
  scanStatus: string;
  downloadable: boolean;
  ownerId: string;
}

export interface MediaVerifyClient {
  /** Throws on transport failure — callers must NOT treat that as verified. */
  checkOne(objectKey: string): Promise<MediaVerdict | null>;
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
    async checkOne(objectKey) {
      const res = await makeGrpcCallWithDeadline<
        { objectKeys: string[] },
        { entries?: Array<Record<string, unknown>> }
      >(
        client,
        "checkMediaStatus",
        { objectKeys: [objectKey] },
        Date.now() + CHECK_DEADLINE_MS
      );
      const entry = (res.entries ?? [])[0];
      if (!entry) return null;
      return {
        scanStatus: String(entry.scanStatus ?? ""),
        downloadable: Boolean(entry.downloadable),
        ownerId: String(entry.ownerId ?? ""),
      };
    },
  };
}

let cached: MediaVerifyClient | undefined;
export function getMediaVerifyClient(): MediaVerifyClient {
  cached ??= createMediaVerifyClient();
  return cached;
}

/** Test seam. */
export function setMediaVerifyClient(
  stub: MediaVerifyClient | undefined
): void {
  cached = stub;
}
