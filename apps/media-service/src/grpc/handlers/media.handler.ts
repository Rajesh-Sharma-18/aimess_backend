import * as grpc from "@grpc/grpc-js";
import type { MediaObject } from "@aimess/shared-types";
import { ForbiddenError } from "@aimess/errors";

import { mediaService } from "../../services/media.service.js";
import type { MediaCategoryKey } from "../../config/uploads.js";

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
        callback({ code: grpc.status.INTERNAL, message: String(err) });
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
        if (err instanceof ForbiddenError) {
          callback({
            code: grpc.status.PERMISSION_DENIED,
            message: (err as Error).message,
          });
        } else {
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      }
    })();
  },
};
