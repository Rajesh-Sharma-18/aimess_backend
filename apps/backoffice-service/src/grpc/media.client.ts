/**
 * Outbound gRPC client to media-service for livestream-thumbnail validation.
 *
 * The thumbnail flow mints its own presigned PUT (`thumbnailService.presignUpload`)
 * and its "confirm" step was a single string refine —
 * `startsWith("stream/thumbnail/") && !includes("..")` — with no HeadObject, no
 * magic bytes, no structural inspection, no AV scan, and no check that the key
 * belonged to THIS livestream. The presigned PUT signs only Content-Type, so the
 * declared 5 MB was never enforced either: a moderator could presign for a 1 KB
 * PNG and store a 500 MB payload of anything.
 *
 * Rather than duplicating the pipeline here (requirement: ONE security policy,
 * not one per upload path), the commit step now asks media-service to run its
 * pipeline over the object. media-service knows the `stream/thumbnail` prefix as
 * a first-class upload category, so it can HEAD, validate, scan, and — on
 * rejection — delete the object.
 *
 * FAIL CLOSED: an unreachable media-service refuses the commit.
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

/**
 * Structural validation reads the whole image, so this is looser than the
 * read-only status check other services use.
 */
const CONFIRM_DEADLINE_MS = 20_000;

export interface MediaConfirmResult {
  scanStatus: string;
  downloadable: boolean;
  fileSize: number;
}

export interface MediaConfirmClient {
  confirmUpload(
    objectKey: string,
    ownerId: string
  ): Promise<MediaConfirmResult>;
}

export function createMediaConfirmClient(): MediaConfirmClient {
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
    async confirmUpload(objectKey, ownerId) {
      const res = await makeGrpcCallWithDeadline<
        { objectKey: string; category: string; ownerId: string },
        Record<string, unknown>
      >(
        client,
        "confirmUpload",
        { objectKey, category: "LIVESTREAM_THUMBNAIL", ownerId },
        Date.now() + CONFIRM_DEADLINE_MS
      );
      return {
        scanStatus: String(res.scanStatus ?? ""),
        downloadable: Boolean(res.downloadable),
        fileSize: Number(res.fileSize ?? 0),
      };
    },
  };
}

let cached: MediaConfirmClient | undefined;
export function getMediaConfirmClient(): MediaConfirmClient {
  cached ??= createMediaConfirmClient();
  return cached;
}

/** Test seam. */
export function setMediaConfirmClient(
  stub: MediaConfirmClient | undefined
): void {
  cached = stub;
}
