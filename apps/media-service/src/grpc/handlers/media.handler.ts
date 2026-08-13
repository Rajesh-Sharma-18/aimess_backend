import * as grpc from "@grpc/grpc-js";
import type { MediaObject } from "@aimess/shared-types";
import { AppError, ForbiddenError } from "@aimess/errors";
import { isDownloadableScanStatus } from "@aimess/constants";
import { logger } from "@aimess/logger";

import { mediaService } from "../../services/media.service.js";
import type { MediaCategoryKey } from "../../config/uploads.js";

/** Cap on keys per CheckMediaStatus call — one message's attachments, not a scan. */
const MAX_STATUS_KEYS = 64;

function toMediaObjectProto(m: MediaObject): object {
  return {
    mediaId: m.mediaId ?? "",
    fileId: m.fileId ?? "",
    objectKey: m.objectKey ?? "",
    fileName: m.fileName ?? "",
    contentType: m.contentType ?? "",
    size: String(m.size ?? 0),
    downloadUrl: m.downloadUrl ?? "",
    downloadUrlExpiresIn: String(m.downloadUrlExpiresIn ?? 0),
    uploadUrl: m.uploadUrl ?? "",
    uploadUrlExpiresIn: String(m.uploadUrlExpiresIn ?? 0),
    uploadHeaders: m.uploadHeaders ?? {},
  };
}

type GrpcCall = grpc.ServerUnaryCall<
  Record<string, unknown>,
  Record<string, unknown>
>;
type GrpcCallback = grpc.sendUnaryData<Record<string, unknown>>;

/**
 * Map an internal error to a gRPC status without leaking its text.
 *
 * `String(err)` used to be returned verbatim as the INTERNAL message, which put
 * whatever escaped — including MinIO SDK errors carrying the endpoint and bucket
 * — on the wire. Callers get the AppError's stable messageKey or nothing.
 */
function toGrpcError(err: unknown): grpc.ServiceError {
  if (err instanceof ForbiddenError) {
    return {
      code: grpc.status.PERMISSION_DENIED,
      message: err.messageKey ?? "FORBIDDEN",
    } as grpc.ServiceError;
  }
  if (err instanceof AppError) {
    return {
      code:
        err.statusCode === 404
          ? grpc.status.NOT_FOUND
          : err.statusCode === 400
            ? grpc.status.INVALID_ARGUMENT
            : grpc.status.INTERNAL,
      message: err.messageKey ?? "MEDIA_ERROR",
    } as grpc.ServiceError;
  }
  logger.error("media gRPC: unhandled error", {
    error: err instanceof Error ? err.message : String(err),
  });
  return {
    code: grpc.status.INTERNAL,
    message: "MEDIA_INTERNAL_ERROR",
  } as grpc.ServiceError;
}

export const mediaImpl: grpc.UntypedServiceImplementation = {
  generateUploadUrl: (call: GrpcCall, callback: GrpcCallback) => {
    void (async () => {
      try {
        const req = call.request as Record<string, string>;
        const result = await mediaService.generateUploadUrl({
          category: req.category as MediaCategoryKey,
          contentType: req.contentType,
          contentLength: Number(req.contentLength),
          ownerId: req.ownerId,
        });
        callback(null, {
          uploadUrl: result.uploadUrl,
          objectKey: result.objectKey,
          expiresIn: String(result.uploadExpiresIn),
          maxBytes: String(result.maxBytes),
          media: toMediaObjectProto(result.media),
        });
      } catch (err) {
        callback(toGrpcError(err));
      }
    })();
  },

  /**
   * Batch scan-verdict lookup for services that persist references to uploaded
   * objects (chat attachments, profile avatars).
   *
   * This exists because those services do NOT go through `/media/download-url`:
   * chat-service presigns MinIO directly on every read (`lib/media-resolve.ts`)
   * and user-service presigns its own avatar GET, so the scan gate — which lives
   * inside `generateDownloadUrl` — was simply not on their path. Verifying at
   * WRITE time is both the stronger and the cheaper fix: an unverified object
   * never becomes a persisted reference, so the read path stays a plain presign.
   */
  checkMediaStatus: (call: GrpcCall, callback: GrpcCallback) => {
    void (async () => {
      try {
        const req = call.request as { objectKeys?: string[] };
        const keys = (req.objectKeys ?? [])
          .filter((k): k is string => typeof k === "string" && k.length > 0)
          .slice(0, MAX_STATUS_KEYS);

        const entries = await mediaService.checkMediaStatus(keys);
        callback(null, {
          entries: entries.map((e) => ({
            objectKey: e.objectKey,
            scanStatus: e.scanStatus ?? "",
            downloadable: e.downloadable,
            ownerId: e.ownerId ?? "",
            resourceId: e.resourceId ?? "",
            contentType: e.contentType ?? "",
            size: String(e.size ?? 0),
          })),
        });
      } catch (err) {
        callback(toGrpcError(err));
      }
    })();
  },

  /** Run the structural pipeline over an object uploaded via another presign. */
  confirmUpload: (call: GrpcCall, callback: GrpcCallback) => {
    void (async () => {
      try {
        const req = call.request as Record<string, string>;
        const result = await mediaService.confirmUpload({
          objectKey: req.objectKey,
          category: req.category as MediaCategoryKey,
          requesterId: req.ownerId,
        });
        callback(null, {
          scanStatus: result.scanStatus,
          downloadable: isDownloadableScanStatus(result.scanStatus),
          fileSize: String(result.fileSize ?? 0),
        });
      } catch (err) {
        callback(toGrpcError(err));
      }
    })();
  },

  generateDownloadUrl: (call: GrpcCall, callback: GrpcCallback) => {
    void (async () => {
      try {
        const req = call.request as Record<string, string>;
        const result = await mediaService.generateDownloadUrl({
          objectKey: req.objectKey,
          category: req.category as MediaCategoryKey,
          requesterId: req.requesterId,
        });
        callback(null, {
          downloadUrl: result.downloadUrl,
          expiresIn: String(result.downloadUrlExpiresIn ?? 0),
          media: toMediaObjectProto(result.media),
        });
      } catch (err) {
        callback(toGrpcError(err));
      }
    })();
  },
};
