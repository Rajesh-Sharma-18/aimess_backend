import type { MediaObject } from "@aimess/shared-types";
import {
  buildUploadMediaObject,
  createUploadUrl,
  createPresignedViewUrl,
  toMediaObject,
  assertObjectKeyOwnedBy,
  deleteObject,
  StorageValidationError,
} from "@aimess/storage";
import {
  BadRequestError,
  ForbiddenError,
  UnsupportedMediaTypeError,
} from "@aimess/errors";

import {
  presignClient,
  storageClient,
  mediaUrlStrategy,
} from "../config/storage.js";
import {
  UPLOAD_CATEGORIES,
  dispositionForKey,
  type MediaCategoryKey,
} from "../config/uploads.js";
import { env } from "../config/env.js";

export type GenerateUploadUrlParams = {
  category: MediaCategoryKey;
  contentType: string;
  contentLength: number;
  ownerId: string;
  /** Optional client-declared original filename (display metadata only). */
  fileName?: string;
};

export type GenerateUploadUrlResult = {
  uploadUrl: string;
  objectKey: string;
  uploadExpiresIn: number;
  maxBytes: number;
  headers: { "Content-Type": string };
  media: MediaObject;
};

export type GenerateDownloadUrlParams = {
  objectKey: string;
  category: MediaCategoryKey;
  requesterId: string;
};

export type GenerateDownloadUrlResult = {
  downloadUrl: string;
  downloadUrlExpiresIn: number;
  media: MediaObject;
};

export type CancelUploadParams = {
  objectKey: string;
  category: MediaCategoryKey;
  requesterId: string;
};

export const mediaService = {
  async generateUploadUrl(
    params: GenerateUploadUrlParams
  ): Promise<GenerateUploadUrlResult> {
    const def = UPLOAD_CATEGORIES[params.category];
    if (!def) {
      throw new BadRequestError("MEDIA_UNKNOWN_CATEGORY");
    }

    try {
      const result = await createUploadUrl({
        client: presignClient,
        def,
        contentType: params.contentType,
        contentLength: params.contentLength,
        ownerId: params.ownerId,
        fileName: params.fileName,
        expiresIn: env.MINIO_PRESIGN_EXPIRES_IN,
      });

      // Resolve a ready GET (download) URL for the minted key so the FE has an
      // immediately-usable URL at upload time (valid once the PUT lands; for
      // instant preview, not persistence — presigned GETs expire ~1h).
      const download = await toMediaObject({
        bucket: def.bucket,
        stored: result.objectKey,
        prefixes: [def.keyPrefix],
        strategy: mediaUrlStrategy,
      });

      return {
        ...result,
        media: {
          ...buildUploadMediaObject({
            result,
            contentType: params.contentType,
            fileName: result.fileName,
          }),
          downloadUrl: download.downloadUrl,
          downloadUrlExpiresIn: download.downloadUrlExpiresIn,
        },
      };
    } catch (error) {
      if (error instanceof StorageValidationError) {
        switch (error.code) {
          case "UNSUPPORTED_CONTENT_TYPE":
          case "EXTENSION_MIME_MISMATCH":
            throw new UnsupportedMediaTypeError(
              "UPLOAD_UNSUPPORTED_CONTENT_TYPE"
            );
          case "FILE_TOO_LARGE":
            throw new BadRequestError("UPLOAD_FILE_TOO_LARGE");
          case "FILE_EMPTY":
            throw new BadRequestError("UPLOAD_FILE_EMPTY");
        }
      }
      throw error;
    }
  },

  async cancelUpload(params: CancelUploadParams): Promise<void> {
    const def = UPLOAD_CATEGORIES[params.category];
    if (!def) throw new BadRequestError("MEDIA_UNKNOWN_CATEGORY");

    // Only allow cancellation of objects the requesting user owns.
    // For avatar / cover categories the objectKey is {prefix}/{ownerId}/...
    // For chat attachments it is {prefix}/{ownerId}/... (assertObjectKeyOwnedBy).
    const owned = assertObjectKeyOwnedBy(
      params.objectKey,
      def.keyPrefix,
      params.requesterId
    );
    if (!owned) throw new ForbiddenError("MEDIA_CANCEL_FORBIDDEN");

    await deleteObject(storageClient, def.bucket, params.objectKey);
  },

  async generateDownloadUrl(
    params: GenerateDownloadUrlParams
  ): Promise<GenerateDownloadUrlResult> {
    const def = UPLOAD_CATEGORIES[params.category];
    if (!def) {
      throw new BadRequestError("MEDIA_UNKNOWN_CATEGORY");
    }

    if (params.category === "CHAT_ATTACHMENT") {
      const owned = assertObjectKeyOwnedBy(
        params.objectKey,
        def.keyPrefix,
        params.requesterId
      );
      if (!owned) {
        throw new ForbiddenError("CHAT_MEDIA_FORBIDDEN");
      }
    } else if (
      params.category === "COMMUNITY_CHAT_ATTACHMENT" ||
      params.category === "GROUP_CHAT_ATTACHMENT"
    ) {
      if (!params.objectKey.startsWith(def.keyPrefix + "/")) {
        throw new BadRequestError("MEDIA_INVALID_OBJECT_KEY");
      }
    }

    const media = await toMediaObject({
      bucket: def.bucket,
      stored: params.objectKey,
      prefixes: [def.keyPrefix],
      strategy: mediaUrlStrategy,
    });

    // Safe-serving: force a download (Content-Disposition: attachment) for
    // non-media object types so an uploaded HTML/SVG/XML payload can never
    // render inline from our origin. Media (image/video/audio) stay inline. Only
    // the small set of document/data downloads is re-signed.
    const disposition = dispositionForKey(params.objectKey);
    if (disposition && media.objectKey) {
      media.downloadUrl = await createPresignedViewUrl({
        client: presignClient,
        bucket: def.bucket,
        objectKey: params.objectKey,
        expiresIn: env.MINIO_VIEW_EXPIRES_IN,
        responseContentDisposition: disposition,
      });
    }

    return {
      downloadUrl: media.downloadUrl ?? "",
      downloadUrlExpiresIn: media.downloadUrlExpiresIn ?? 0,
      media,
    };
  },
};
