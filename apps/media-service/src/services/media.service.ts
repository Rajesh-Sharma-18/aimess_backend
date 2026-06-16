import type { MediaObject } from "@aimess/shared-types";
import {
  buildUploadMediaObject,
  createUploadUrl,
  createPresignedViewUrl,
  toMediaObject,
  assertObjectKeyOwnedBy,
  deleteObject,
  headObject,
  StorageValidationError,
} from "@aimess/storage";
import {
  BadRequestError,
  ForbiddenError,
  GoneError,
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
import { validateUpload } from "../lib/magic-validator.js";
import {
  scanStatusStore,
  enqueueScan,
  runScanAndPersist,
  type MediaScanStatus,
} from "../lib/scanner.js";

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

export type ConfirmUploadParams = {
  objectKey: string;
  category: MediaCategoryKey;
  contentType: string;
  requesterId: string;
};

export type ConfirmUploadResult = {
  objectKey: string;
  scanStatus: MediaScanStatus;
  /** Populated on CLEAN — clients can store this to reference the file. */
  fileSize?: number;
};

export type GetScanStatusParams = {
  objectKey: string;
  category: MediaCategoryKey;
  requesterId: string;
};

export type GetScanStatusResult = {
  objectKey: string;
  scanStatus: MediaScanStatus;
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

  async confirmUpload(
    params: ConfirmUploadParams
  ): Promise<ConfirmUploadResult> {
    const def = UPLOAD_CATEGORIES[params.category];
    if (!def) throw new BadRequestError("MEDIA_UNKNOWN_CATEGORY");

    const owned = assertObjectKeyOwnedBy(
      params.objectKey,
      def.keyPrefix,
      params.requesterId
    );
    if (!owned) throw new ForbiddenError("MEDIA_CONFIRM_FORBIDDEN");

    // Mark PENDING immediately so the download endpoint blocks while the scan
    // is in progress.
    await scanStatusStore.set(params.objectKey, "PENDING");

    // Structural validation (magic-byte + ZIP inspection) runs synchronously;
    // the AV scan is deferred to the Bull worker.
    const result = await validateUpload({
      bucket: def.bucket,
      objectKey: params.objectKey,
      declaredMime: params.contentType,
    });

    // Structural rejection (magic-byte / ZIP bomb / OOXML mismatch) — throw
    // immediately so the frontend gets an error during the upload flow.
    if (result.status === "REJECTED") {
      await scanStatusStore.set(params.objectKey, "INFECTED");
      await deleteObject(storageClient, def.bucket, params.objectKey);
      throw new UnsupportedMediaTypeError("MEDIA_FILE_REJECTED");
    }

    // AV scan: virus detected — throw so the frontend is notified immediately.
    if (result.status === "QUARANTINED") {
      await scanStatusStore.set(params.objectKey, "QUARANTINED");
      await deleteObject(storageClient, def.bucket, params.objectKey);
      throw new GoneError("MEDIA_FILE_QUARANTINED");
    }

    if (result.status === "ERROR") {
      // Leave status PENDING (set above); client can retry /confirm.
      return {
        objectKey: params.objectKey,
        scanStatus: "ERROR",
        fileSize: result.fileSize,
      };
    }

    // Structure CLEAN. In dev (no-op scanner) there is nothing to scan, so set
    // CLEAN inline and preserve the synchronous dev UX.
    if (!env.CLAMAV_ENABLED) {
      await scanStatusStore.set(params.objectKey, "CLEAN");
      return {
        objectKey: params.objectKey,
        scanStatus: "CLEAN",
        fileSize: result.fileSize,
      };
    }

    // Production: enqueue the AV scan off the request thread; respond PENDING.
    const enqueued = await enqueueScan({
      bucket: def.bucket,
      objectKey: params.objectKey,
      contentType: params.contentType,
    });
    if (enqueued) {
      return {
        objectKey: params.objectKey,
        scanStatus: "PENDING",
        fileSize: result.fileSize,
      };
    }

    // Enqueue failed (Bull/Redis down) — fall back to an inline scan so the
    // file never gets stuck PENDING. Slow path; matches degrade-gracefully.
    const status = await runScanAndPersist({
      bucket: def.bucket,
      objectKey: params.objectKey,
      contentType: params.contentType,
    });
    const scanStatus: MediaScanStatus = status === "PENDING" ? "ERROR" : status;
    return {
      objectKey: params.objectKey,
      scanStatus,
      fileSize: result.fileSize,
    };
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

    // Scan-status gate: only CLEAN (or SKIPPED for no-op scanner) files may
    // be downloaded. If no status exists (file never confirmed), auto-confirm
    // on first download-url call so the frontend doesn't need to call /confirm.
    let scanStatus = await scanStatusStore.get(params.objectKey);

    if (scanStatus === null) {
      // Auto-confirm: run validation pipeline (magic-byte, ZIP, optional AV scan).
      // Read the Content-Type from MinIO metadata (set by client at PUT time).
      const head = await headObject(
        storageClient,
        def.bucket,
        params.objectKey
      );
      if (!head.exists) {
        throw new BadRequestError("MEDIA_NOT_FOUND");
      }
      const contentType = head.contentType ?? "application/octet-stream";

      const confirmResult = await this.confirmUpload({
        objectKey: params.objectKey,
        category: params.category,
        contentType,
        requesterId: params.requesterId,
      });
      scanStatus = confirmResult.scanStatus;
    }

    if (scanStatus === "QUARANTINED" || scanStatus === "INFECTED") {
      throw new ForbiddenError("MEDIA_QUARANTINED");
    }
    if (scanStatus === "PENDING") {
      throw new ForbiddenError("MEDIA_SCAN_PENDING");
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

  async getScanStatus(
    params: GetScanStatusParams
  ): Promise<GetScanStatusResult> {
    const def = UPLOAD_CATEGORIES[params.category];
    if (!def) throw new BadRequestError("MEDIA_UNKNOWN_CATEGORY");

    // Authz mirrors generateDownloadUrl.
    if (params.category === "CHAT_ATTACHMENT") {
      const owned = assertObjectKeyOwnedBy(
        params.objectKey,
        def.keyPrefix,
        params.requesterId
      );
      if (!owned) throw new ForbiddenError("CHAT_MEDIA_FORBIDDEN");
    } else if (
      params.category === "COMMUNITY_CHAT_ATTACHMENT" ||
      params.category === "GROUP_CHAT_ATTACHMENT"
    ) {
      if (!params.objectKey.startsWith(def.keyPrefix + "/")) {
        throw new BadRequestError("MEDIA_INVALID_OBJECT_KEY");
      }
    }

    // null (missing / expired / Redis-down) → PENDING. Never report a
    // false-clean to a polling client. (This deliberately differs from
    // generateDownloadUrl, which fail-opens on null for un-Redis'd dev.)
    const status = await scanStatusStore.get(params.objectKey);
    return {
      objectKey: params.objectKey,
      scanStatus: status ?? "PENDING",
    };
  },
};
