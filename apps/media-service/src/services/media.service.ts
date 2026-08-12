import type { MediaObject } from "@aimess/shared-types";
import {
  buildUploadMediaObject,
  createUploadUrl,
  createPresignedViewUrl,
  toMediaObject,
  assertObjectKeyOwnedBy,
  deleteObject,
  headObject,
  effectiveMaxBytes,
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
  resolveCategoryFromObjectKey,
  type MediaCategoryKey,
} from "../config/uploads.js";
import { env } from "../config/env.js";
import { validateUpload } from "../lib/magic-validator.js";
import {
  scanStatusStore,
  enqueueScan,
  runScanAndPersist,
  publishScanResult,
  type MediaScanStatus,
} from "../lib/scanner.js";
import { logger } from "@aimess/logger";
import { RESOURCE_OWNER_TYPE } from "@aimess/constants";
import { mediaFileRepository } from "../repositories/media-file.repository.js";
import { resolveResourceType } from "../lib/resource-type.js";
import {
  authorizeMediaAccess,
  assertUploadResourceAccess,
} from "../lib/download-authz.js";

export type GenerateUploadUrlParams = {
  category: MediaCategoryKey;
  contentType: string;
  contentLength: number;
  /** Authenticated owner (from JWT token). */
  ownerId: string;
  /** Entity the file belongs to (roomId/groupId/communityId) — drives download authz. */
  resourceId?: string;
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
  downloadUrlExpiresIn: number | null;
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

    // The caller must actually belong to the resource they're filing this under.
    // `resourceId` was written to the registry on trust, and the registry is
    // what the DOWNLOAD guard reads back — so an unverified one both files an
    // object into someone else's scope and poisons its own authorization.
    await assertUploadResourceAccess({
      category: params.category,
      resourceId: params.resourceId,
      requesterId: params.ownerId,
    });

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

      // Register the object in the media registry (best-effort): binds the
      // storage key to its owner + resource + classification so downloads can be
      // authorized against resource membership and orphans cleaned up. A registry
      // failure must never break URL issuance — isolated in its own try/catch.
      // The registry row's own `id` (stable Mongo ObjectId, keyed by the unique
      // objectKey — see mediaFileRepository.register) becomes the durable
      // `mediaId` surfaced to clients, independent of objectKey/url.
      let mediaId: string | null = null;
      try {
        const resourceType = resolveResourceType(
          params.category,
          params.contentType
        );
        const registered = await mediaFileRepository.register({
          objectKey: result.objectKey,
          bucket: def.bucket,
          uploadCategory: params.category,
          ownerType: RESOURCE_OWNER_TYPE[resourceType],
          resourceType,
          ownerId: params.ownerId,
          resourceId: params.resourceId ?? null,
          fileName: result.fileName ?? null,
          contentType: params.contentType,
          size: params.contentLength,
          scanStatus: "PENDING",
        });
        mediaId = registered.id;
      } catch (err) {
        logger.warn("media registry: register on upload-url failed", {
          objectKey: result.objectKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return {
        ...result,
        media: {
          ...buildUploadMediaObject({
            result,
            contentType: params.contentType,
            fileName: result.fileName,
            mediaId,
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
      maxBytes: effectiveMaxBytes(def, params.contentType),
    });

    // Structural rejection (magic-byte / ZIP bomb / OOXML mismatch) is terminal:
    // mark the object unsafe and remove it. confirm always RESPONDS 200 with the
    // verdict in `scanStatus` (the published OpenAPI contract + the async poll
    // model — PENDING cannot be thrown, so every verdict returns uniformly). The
    // download gate blocks anything outside {CLEAN, SKIPPED}, so a rejected file
    // is never served regardless of label.
    if (result.status === "REJECTED") {
      await scanStatusStore.set(params.objectKey, "INFECTED");
      await deleteObject(storageClient, def.bucket, params.objectKey);
      publishScanResult(params.objectKey, "INFECTED", result.reason);
      return {
        objectKey: params.objectKey,
        scanStatus: "INFECTED",
        fileSize: result.fileSize,
      };
    }

    // AV scan flagged the file (only reachable if the structural validator ever
    // surfaces a QUARANTINED verdict). Same terminal treatment.
    if (result.status === "QUARANTINED") {
      await scanStatusStore.set(params.objectKey, "QUARANTINED");
      await deleteObject(storageClient, def.bucket, params.objectKey);
      publishScanResult(params.objectKey, "QUARANTINED", result.reason);
      return {
        objectKey: params.objectKey,
        scanStatus: "QUARANTINED",
        fileSize: result.fileSize,
      };
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
    // A client occasionally forwards an already-external URL as `objectKey`
    // (e.g. a GIF/Sticker picked from Giphy/Tenor, which has no MinIO object
    // behind it at all). There is nothing to sign or authorize — the value
    // IS the download URL — so short-circuit before any bucket/category/auth
    // lookup, which would otherwise misinterpret the URL as a storage key and
    // either 404 (no matching object) or throw on an unrecognized category.
    if (/^https?:\/\//i.test(params.objectKey)) {
      return {
        downloadUrl: params.objectKey,
        downloadUrlExpiresIn: null,
        media: {
          mediaId: null,
          fileId: null,
          objectKey: null,
          fileName: null,
          contentType: null,
          size: null,
          downloadUrl: params.objectKey,
          downloadUrlExpiresIn: null,
          uploadUrl: null,
          uploadUrlExpiresIn: null,
        },
      };
    }

    // The objectKey is the ground truth for where the file physically lives
    // (bucket + keyPrefix). Trust the key's own prefix over the client-supplied
    // category when they disagree (e.g. a `community-chat-uploads/…` key sent
    // with `category: "CHAT_ATTACHMENT"`) — otherwise the wrong keyPrefix makes
    // toMediaObject fail to resolve the key and return an all-null MediaObject.
    const matchedCategory = resolveCategoryFromObjectKey(params.objectKey);

    // Every real objectKey minted by this service (createUploadUrl) is written
    // under one of the known keyPrefix folders — a value that matches none of
    // them (and isn't an external URL, already handled above) was never a
    // valid key at all: a bare provider id (e.g. a raw Giphy/Tenor id instead
    // of its full media URL), a stickerId/mediaId sent in the wrong field, or
    // similar client-side mistake. Fail fast with a diagnosable error instead
    // of falling through to a MinIO HEAD lookup that can only ever produce a
    // misleading MEDIA_NOT_FOUND ("file was deleted") for input that was
    // never a storage key to begin with.
    if (matchedCategory === null) {
      throw new BadRequestError("MEDIA_INVALID_OBJECT_KEY");
    }

    const effectiveCategory = matchedCategory;
    const def = UPLOAD_CATEGORIES[effectiveCategory];
    if (!def) {
      throw new BadRequestError("MEDIA_UNKNOWN_CATEGORY");
    }

    // Resource-driven authorization. For registered objects this enforces the
    // resource-type policy (chat attachments → membership verified via
    // chat-service gRPC, closing the community/group IDOR and the private-chat
    // recipient gap); for un-backfilled keys it falls back to the legacy
    // prefix/owner checks.
    await authorizeMediaAccess({
      objectKey: params.objectKey,
      category: effectiveCategory,
      requesterId: params.requesterId,
    });

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

      // Extract the real ownerId from the objectKey path ({prefix}/{ownerId}/…)
      // so the ownership check inside confirmUpload passes even when the caller
      // is not the uploader. Authorization has already been enforced above by
      // authorizeMediaAccess, so this bypass is safe.
      const ownerIdFromKey =
        params.objectKey.slice(def.keyPrefix.length + 1).split("/")[0] ||
        params.requesterId;

      const confirmResult = await this.confirmUpload({
        objectKey: params.objectKey,
        category: effectiveCategory,
        contentType,
        requesterId: ownerIdFromKey,
      });
      scanStatus = confirmResult.scanStatus;
    }

    // Allow-list gate (defense in depth). Only a terminal CLEAN — or SKIPPED
    // when AV scanning is disabled (dev/no-op scanner) — is downloadable.
    // Everything else (PENDING, ERROR, a terminal scanner failure, or any
    // unexpected/future value) is blocked. Inverting a former block-list to an
    // allow-list means a new or errored status can never fail open and serve an
    // unverified object.
    if (scanStatus === "QUARANTINED" || scanStatus === "INFECTED") {
      throw new ForbiddenError("MEDIA_QUARANTINED");
    }
    if (scanStatus !== "CLEAN" && scanStatus !== "SKIPPED") {
      // PENDING (scan in flight), ERROR (terminal scan failure), or any value
      // outside the safe set — not yet/never downloadable.
      throw new ForbiddenError("MEDIA_SCAN_PENDING");
    }

    // Legacy/unregistered objects (uploaded before the registry existed, or a
    // failed best-effort register) simply have no MediaFile row — mediaId
    // gracefully falls back to null rather than breaking the download.
    const registered = await mediaFileRepository.findByObjectKey(
      params.objectKey
    );

    const media = await toMediaObject({
      bucket: def.bucket,
      stored: params.objectKey,
      prefixes: [def.keyPrefix],
      strategy: mediaUrlStrategy,
      mediaId: registered?.id ?? null,
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
      downloadUrlExpiresIn: media.downloadUrlExpiresIn,
      media,
    };
  },

  async getScanStatus(
    params: GetScanStatusParams
  ): Promise<GetScanStatusResult> {
    // Trust the objectKey's own prefix over a mismatched client category
    // (mirrors generateDownloadUrl) so authz uses the right resolution.
    const effectiveCategory =
      resolveCategoryFromObjectKey(params.objectKey) ?? params.category;
    const def = UPLOAD_CATEGORIES[effectiveCategory];
    if (!def) throw new BadRequestError("MEDIA_UNKNOWN_CATEGORY");

    // Authz mirrors generateDownloadUrl (resource-driven, registry-bound).
    await authorizeMediaAccess({
      objectKey: params.objectKey,
      category: effectiveCategory,
      requesterId: params.requesterId,
    });

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
