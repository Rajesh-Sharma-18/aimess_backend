import type { MediaObject } from "@aimess/shared-types";
import {
  buildUploadMediaObject,
  createUploadUrl,
  createPresignedViewUrl,
  toMediaObject,
  assertObjectKeyOwnedBy,
  headObject,
  effectiveMaxBytes,
  StorageValidationError,
} from "@aimess/storage";
import {
  BadRequestError,
  ForbiddenError,
  ServiceUnavailableError,
  UnsupportedMediaTypeError,
} from "@aimess/errors";
import {
  publishAdminActivitySafe,
  USER_AUDIT_ACTIONS,
} from "@aimess/messaging";

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
import { isAllowedExternalMediaUrl, isHttpUrl } from "@aimess/utils";
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
import {
  PUBLIC_REJECT_REASON,
  RESOURCE_OWNER_TYPE,
  isDownloadableScanStatus,
  isMediaScanStatus,
  type MediaPublicRejectReason,
} from "@aimess/constants";
import { mediaFileRepository } from "../repositories/media-file.repository.js";
import { resolveResourceType } from "../lib/resource-type.js";
import {
  deleteObjectSafely,
  quarantineObject,
  recordVerdict,
} from "../lib/media-cleanup.js";
import {
  authorizeMediaAccess,
  assertUploadResourceAccess,
} from "../lib/download-authz.js";
import {
  currentPeriodStart,
  summarizeUsage,
  type DataUsageSummary,
} from "../lib/data-usage.js";

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
  requesterId: string;
};

export type ConfirmUploadResult = {
  objectKey: string;
  scanStatus: MediaScanStatus;
  /** Populated on CLEAN — clients can store this to reference the file. */
  fileSize?: number;
  /**
   * Populated on REJECTED only: the coarse, client-safe bucket the uploader is
   * shown ("this file is damaged", "this file is not the type it claims"). The
   * precise detector verdict stays in the audit log — see PUBLIC_REJECT_REASON.
   */
  reason?: MediaPublicRejectReason;
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

export type GetDataUsageParams = {
  /** Authenticated caller. There is no by-id variant: usage is private. */
  userId: string;
};

export type GetDataUsageResult = DataUsageSummary & {
  /** Inclusive start of the reported window (serialized to epoch ms). */
  periodStart: Date;
  /**
   * Which direction of transfer `totalBytes` covers. Only "UPLOAD" is
   * produceable today; the field exists so adding downloads later is a value
   * change rather than a breaking contract change.
   */
  measured: "UPLOAD";
};

/** One row of the internal batch verdict lookup (gRPC `CheckMediaStatus`). */
export type MediaStatusEntry = {
  objectKey: string;
  /** null when the key is unknown to both the cache and the registry. */
  scanStatus: MediaScanStatus | null;
  /** The ONLY field callers should gate on — CLEAN/SKIPPED, nothing else. */
  downloadable: boolean;
  ownerId: string | null;
  resourceId: string | null;
  contentType: string | null;
  size: number | null;
};

/**
 * Resolve the MIME the validator is allowed to trust for an object.
 *
 * The `contentType` a client sends to `/media/confirm` is worthless as a
 * security input, and was previously the ONLY input: it selected which magic-
 * byte accept-set applied, whether ZIP inspection ran at all, and which per-MIME
 * size cap was enforced. Requesting an upload URL as `image/png`, PUTting an
 * arbitrary payload, then confirming as `text/plain` reached an empty accept-set,
 * skipped every structural check, and returned CLEAN.
 *
 * Two server-side witnesses exist, in order of authority:
 *
 *  1. The MediaFile registry row, written at upload-url mint from the MIME that
 *     was checked against the category allow-list.
 *  2. MinIO's stored Content-Type. The presigned PUT signs Content-Type (see
 *     packages/storage/presign.ts), so the client could not have stored a value
 *     other than the one the server signed.
 *
 * Returns null when the object does not exist.
 */
async function resolveTrustedContentType(
  bucket: string,
  objectKey: string
): Promise<string | null> {
  const head = await headObject(storageClient, bucket, objectKey);
  if (!head.exists) return null;

  const registered = await mediaFileRepository
    .findByObjectKey(objectKey)
    .catch(() => null);

  return registered?.contentType ?? head.contentType ?? null;
}

/**
 * Structured security-event log.
 *
 * Everything an incident responder needs (who, what, how big, which digest,
 * which detector fired) goes to the INTERNAL log only. None of these fields is
 * ever placed in an API response or a socket payload — see
 * docs/MEDIA_SECURITY_AUDIT.md §Logging. File CONTENTS are never logged.
 */
function logSecurityEvent(fields: Record<string, unknown>): void {
  logger.info("media-security", { ...fields, at: new Date().toISOString() });
}

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

      // NOTE: no download URL is returned here, deliberately.
      //
      // This endpoint used to mint and return a presigned GET alongside the PUT,
      // "for instant preview". That URL is a bearer credential valid for
      // MINIO_VIEW_EXPIRES_IN, redeemed directly against MinIO — which means it
      // bypasses the ENTIRE security pipeline: the scan gate lives in
      // `generateDownloadUrl`, not in storage, so those bytes were served the
      // moment the PUT landed, unscanned, to anyone the uploader forwarded the
      // link to. The uploader already holds the file locally and does not need a
      // URL to preview it; every other reader goes through `/media/download-url`
      // after `/media/confirm` returns CLEAN.

      // Register the object in the media registry. This binds the storage key to
      // its owner + resource + classification, and it is what BOTH the download
      // guard and the confirm-time MIME check read back.
      //
      // This used to be best-effort (a swallowed try/catch). A single Mongo blip
      // during upload-url therefore produced a permanently un-registered object,
      // and the fallback path for "no registry row" is weaker than the real one:
      // a group avatar became world-readable and a chat attachment became
      // uploader-only. An object we cannot authorize later must not be minted at
      // all, so registration failure now fails the request instead.
      const resourceType = resolveResourceType(
        params.category,
        params.contentType
      );
      let mediaId: string;
      try {
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
        logger.error("media registry: register on upload-url failed", {
          severity: "critical",
          event: "media.register_failed",
          objectKey: result.objectKey,
          error: err instanceof Error ? err.message : String(err),
        });
        throw new ServiceUnavailableError("MEDIA_REGISTRY_UNAVAILABLE");
      }

      return {
        ...result,
        media: buildUploadMediaObject({
          result,
          contentType: params.contentType,
          fileName: result.fileName,
          mediaId,
        }),
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

    // The MIME the validator runs against MUST come from the server, never from
    // this request body. See `resolveTrustedContentType` for why.
    const trustedMime = await resolveTrustedContentType(
      def.bucket,
      params.objectKey
    );
    if (!trustedMime) {
      throw new BadRequestError("MEDIA_NOT_FOUND");
    }

    // Mark PENDING immediately so the download endpoint blocks while the scan
    // is in progress.
    await scanStatusStore.set(params.objectKey, "PENDING");

    // Structural validation (magic bytes + deep format inspection + ZIP) runs
    // synchronously; the AV scan is deferred to the Bull worker.
    const result = await validateUpload({
      bucket: def.bucket,
      objectKey: params.objectKey,
      declaredMime: trustedMime,
      maxBytes: effectiveMaxBytes(def, trustedMime),
    });

    // Structural rejection is terminal: record the durable verdict, remove the
    // bytes, and tell the uploader. confirm always RESPONDS 200 with the verdict
    // in `scanStatus` (the published OpenAPI contract + the async poll model —
    // PENDING cannot be thrown, so every verdict returns uniformly). The download
    // gate blocks anything outside {CLEAN, SKIPPED}, so a rejected file is never
    // served regardless of label.
    //
    // The label is REJECTED, not INFECTED. The two were conflated: a magic-byte
    // mismatch or an oversize file reported "INFECTED" while an actual ClamAV
    // detection reported "QUARANTINED" — exactly backwards from what the names
    // imply, and impossible for a client to act on differently.
    if (result.status === "REJECTED") {
      await scanStatusStore.set(params.objectKey, "REJECTED");
      await quarantineObject({
        bucket: def.bucket,
        objectKey: params.objectKey,
        status: "REJECTED",
        detail: `${result.rejectCode ?? "REJECTED"}: ${result.reason ?? ""}`,
        sha256: result.sha256,
      });
      logSecurityEvent({
        event: "media.structural_rejection",
        objectKey: params.objectKey,
        ownerId: params.requesterId,
        contentType: trustedMime,
        fileSize: result.fileSize,
        rejectCode: result.rejectCode,
        detail: result.reason,
        sha256: result.sha256,
      });
      // The uploader is told the coarse reason only — never the detector detail.
      publishScanResult(params.objectKey, "REJECTED");
      return {
        objectKey: params.objectKey,
        scanStatus: "REJECTED",
        fileSize: result.fileSize,
        reason: result.rejectCode
          ? PUBLIC_REJECT_REASON[result.rejectCode]
          : undefined,
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

    // Structure CLEAN — persist what we learned about the object regardless of
    // which scan branch runs next.
    if (result.fileSize != null) {
      await mediaFileRepository
        .setVerifiedSize(params.objectKey, result.fileSize)
        .catch(() => undefined);
    }
    logSecurityEvent({
      event: "media.structural_pass",
      objectKey: params.objectKey,
      ownerId: params.requesterId,
      contentType: trustedMime,
      fileSize: result.fileSize,
      sha256: result.sha256,
      width: result.inspection?.width,
      height: result.inspection?.height,
      frames: result.inspection?.frames,
      durationMs: result.inspection?.durationMs,
      metadata: result.inspection?.metadata,
    });

    // In dev (no-op scanner) there is nothing to scan, so settle inline and
    // preserve the synchronous dev UX. SKIPPED — not CLEAN — because no AV
    // engine ran: `scanner.ts` documented SKIPPED as the dev verdict but every
    // path wrote CLEAN, making the distinction unobservable in the data.
    if (!env.CLAMAV_ENABLED) {
      await scanStatusStore.set(params.objectKey, "SKIPPED");
      await recordVerdict({
        objectKey: params.objectKey,
        status: "SKIPPED",
        detail: "structural checks passed; AV scanning disabled",
        sha256: result.sha256,
      });
      return {
        objectKey: params.objectKey,
        scanStatus: "SKIPPED",
        fileSize: result.fileSize,
      };
    }

    // Production: enqueue the AV scan off the request thread; respond PENDING.
    const enqueued = await enqueueScan({
      bucket: def.bucket,
      objectKey: params.objectKey,
      contentType: trustedMime,
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
      contentType: trustedMime,
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

    // Routed through the shared cleanup helper so a failed delete is logged as a
    // critical event instead of escaping as a 500 that leaves an object nothing
    // in the system knows about.
    const deleted = await deleteObjectSafely(def.bucket, params.objectKey, {
      reason: "upload cancelled by uploader",
      requesterId: params.requesterId,
    });
    if (deleted) {
      // Transition the registry row so the orphan sweep does not later re-count
      // an object that is already gone. `setUsage` existed with a
      // `[usageStatus, unusedAt]` index built for exactly this and had no
      // production caller — the lifecycle was indexed but never driven.
      await mediaFileRepository
        .setUsage(params.objectKey, "DELETED")
        .catch(() => undefined);

      // Only inside `deleted` — a failed storage delete must not be audited as
      // a destroyed object.
      publishAdminActivitySafe({
        actorId: params.requesterId,
        action: USER_AUDIT_ACTIONS.MEDIA_DELETED,
        targetType: "media",
        targetId: params.objectKey,
        after: { category: params.category, reason: "upload_cancelled" },
      });
    }
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
    //
    // The reflection is bounded by the provider allowlist. The audit's own
    // reviewer refuted this as an SSRF or a laundering primitive on its own —
    // the caller gets back a value it already had, nothing is fetched and
    // nothing is stored — but this endpoint is also the read side of an
    // attachment somebody ELSE stored, so the two surfaces must agree on which
    // hosts are legitimate. The send-time guard now enforces the same list.
    if (isHttpUrl(params.objectKey)) {
      if (!isAllowedExternalMediaUrl(params.objectKey)) {
        throw new ForbiddenError("MEDIA_NOT_VERIFIED");
      }
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

    // Scan-status gate. Redis is the hot cache; the MediaFile registry is the
    // durable record. Reading Redis alone meant that once SCAN_STATUS_TTL_SECONDS
    // (7 days) elapsed — or Redis was flushed — a QUARANTINED verdict simply
    // vanished and every object fell back into auto-confirm, re-validating the
    // whole corpus and stampeding the scan queue. Falling back to the registry
    // keeps terminal verdicts terminal.
    const registered = await mediaFileRepository
      .findByObjectKey(params.objectKey)
      .catch(() => null);

    let scanStatus =
      (await scanStatusStore.get(params.objectKey)) ??
      (isMediaScanStatus(registered?.scanStatus ?? "")
        ? (registered!.scanStatus as MediaScanStatus)
        : null);

    // A registry row that still reads PENDING may simply never have been
    // confirmed; treat that the same as "no status" so auto-confirm can settle
    // it, rather than blocking the object forever.
    if (scanStatus === "PENDING" && registered && !registered.scannedAt) {
      scanStatus = null;
    }

    if (scanStatus === null) {
      // Auto-confirm: run the full validation pipeline. `confirmUpload` resolves
      // the trusted MIME itself (registry row, else MinIO's signed metadata), so
      // nothing client-supplied reaches the validator on this path either.
      //
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
        requesterId: ownerIdFromKey,
      });
      scanStatus = confirmResult.scanStatus;
    }

    // Allow-list gate (defense in depth). Only a terminal CLEAN — or SKIPPED
    // when AV scanning is disabled (dev/no-op scanner) — is downloadable.
    // Everything else (PENDING, ERROR, REJECTED, a terminal scanner failure, or
    // any unexpected/future value) is blocked. The allow-list itself lives in
    // @aimess/constants so a new status added there defaults to blocked here
    // without anyone having to remember to update this branch.
    if (
      !isDownloadableScanStatus(scanStatus, {
        allowUnscanned: !env.CLAMAV_ENABLED,
      })
    ) {
      // Distinct codes per class so the client can render the right thing and
      // decide whether retrying is pointless. All three previously collapsed to
      // one 403, so "malware" and "come back in five seconds" were the same
      // response.
      switch (scanStatus) {
        case "INFECTED":
        case "QUARANTINED":
          throw new ForbiddenError("MEDIA_MALWARE_DETECTED");
        case "REJECTED":
          throw new ForbiddenError("MEDIA_SECURITY_VALIDATION_FAILED");
        case "ERROR":
          throw new ForbiddenError("MEDIA_SCAN_FAILED");
        default:
          // PENDING / SCANNING / any future value — not yet downloadable.
          throw new ForbiddenError("MEDIA_SCAN_PENDING");
      }
    }

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

  /**
   * Batch scan-verdict lookup for INTERNAL callers (gRPC only — never exposed on
   * the public API, because it answers about objects the caller may not own).
   *
   * Read-only and side-effect free by design: it must never trigger the
   * auto-confirm path, or a service calling it in a hot read loop would drive
   * re-validation of the entire corpus.
   *
   * Redis first (hot), registry second (durable). A key with neither is reported
   * `scanStatus: null, downloadable: false` — an object nothing has verified is
   * never safe to persist a reference to.
   */
  async checkMediaStatus(objectKeys: string[]): Promise<MediaStatusEntry[]> {
    if (objectKeys.length === 0) return [];

    const rows = await mediaFileRepository
      .findByObjectKeys(objectKeys)
      .catch(() => []);
    const byKey = new Map(rows.map((r) => [r.objectKey, r]));

    return Promise.all(
      objectKeys.map(async (objectKey) => {
        const row = byKey.get(objectKey);
        const cached = await scanStatusStore.get(objectKey).catch(() => null);
        const durable = isMediaScanStatus(row?.scanStatus ?? "")
          ? (row!.scanStatus as MediaScanStatus)
          : null;
        // Prefer the durable verdict when it is TERMINAL: a scanned-and-rejected
        // object must not become downloadable again just because its Redis key
        // rolled over back to a fresh PENDING.
        const scanStatus =
          durable && durable !== "PENDING" && durable !== "SCANNING"
            ? durable
            : (cached ?? durable);

        return {
          objectKey,
          scanStatus,
          downloadable: scanStatus
            ? isDownloadableScanStatus(scanStatus, {
                allowUnscanned: !env.CLAMAV_ENABLED,
              })
            : false,
          ownerId: row?.ownerId ?? null,
          resourceId: row?.resourceId ?? null,
          contentType: row?.contentType ?? null,
          size: row?.size ?? null,
        };
      })
    );
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

  /**
   * GET /media/usage/me — this user's upload bytes for the current calendar
   * month, split by media kind.
   *
   * Reads the MediaFile registry directly rather than maintaining a counter:
   * every byte fact already sits on one collection, keyed by ownerId and
   * indexed by [ownerId, createdAt]. A rollup table would be a second copy to
   * keep correct for no measured benefit.
   *
   * `measured: "UPLOAD"` is part of the contract, not a note — it tells web,
   * iOS, and Android what this total covers so none of them label it "network
   * usage". Downloads are not measurable in this architecture; see
   * lib/data-usage.ts and docs/DATA_USAGE_PHASE1_AUDIT.md.
   */
  async getDataUsage(params: GetDataUsageParams): Promise<GetDataUsageResult> {
    const periodStart = currentPeriodStart(new Date());
    const rows = await mediaFileRepository.sumVerifiedBytesByMime(
      params.userId,
      periodStart
    );

    return {
      periodStart,
      measured: "UPLOAD",
      ...summarizeUsage(rows),
    };
  },
};
