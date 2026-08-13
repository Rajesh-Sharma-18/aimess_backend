/**
 * Quarantine / cleanup — the single exit path for "this object must not remain
 * in storage".
 *
 * Two problems this fixes:
 *
 *   1. **A failed delete used to be invisible.** `deleteObject` is a bare
 *      `await client.send(...)` with no try/catch (packages/storage/buckets.ts),
 *      and every call site awaited it bare. If MinIO was down or the credentials
 *      lost DeleteObject permission, the rejection either 500'd the request or
 *      escaped into Bull — and in BOTH cases the caller had already written a
 *      terminal "removed" verdict. A known-malicious object stayed in the bucket
 *      with nothing in the system recording that fact. Cleanup failure is now a
 *      loud, structured `critical` log AND a durable `MediaFile` row
 *      (`scanStatus`, `scanDetail`) that an operator can query.
 *   2. **The verdict was only ever written to Redis**, under a 7-day TTL. Once
 *      it expired there was no durable record that an object had ever been
 *      rejected. Every verdict now lands in the registry too, which is what the
 *      download gate falls back to when Redis has nothing.
 *
 * `quarantineObject` never throws. The download gate blocks the object on its
 * status regardless of whether the bytes could be removed, so a cleanup failure
 * must degrade to "blocked and loudly logged", never to "request failed and the
 * verdict was lost".
 */

import { deleteObject } from "@aimess/storage";
import { logger } from "@aimess/logger";
import type { MediaScanStatus } from "@aimess/constants";

import { storageClient } from "../config/storage.js";
import { mediaFileRepository } from "../repositories/media-file.repository.js";

export interface QuarantineParams {
  bucket: string;
  objectKey: string;
  /** Terminal verdict to persist: REJECTED | INFECTED | QUARANTINED. */
  status: MediaScanStatus;
  /** INTERNAL detail for the audit trail. Never returned to a client. */
  detail?: string;
  /** SHA-256 of the rejected bytes, when it was computed. */
  sha256?: string;
}

export interface QuarantineOutcome {
  /** True when the bytes are confirmed gone from storage. */
  deleted: boolean;
  /** True when the durable verdict was written to the registry. */
  recorded: boolean;
}

/**
 * Delete an object, converting a failure into a loud, structured log instead of
 * a thrown rejection. Returns whether the bytes are confirmed gone.
 *
 * NEVER report success without this returning true: the whole point is that
 * "we deleted it" must be an observation, not an assumption.
 */
export async function deleteObjectSafely(
  bucket: string,
  objectKey: string,
  context: Record<string, unknown> = {}
): Promise<boolean> {
  try {
    await deleteObject(storageClient, bucket, objectKey);
    return true;
  } catch (err) {
    logger.error("media-cleanup: FAILED to delete object from storage", {
      severity: "critical",
      event: "media.cleanup_failed",
      bucket,
      objectKey,
      ...context,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Remove an unsafe object from storage and durably record why. Best-effort on
 * both halves, but every failure is surfaced — nothing here is swallowed.
 */
export async function quarantineObject(
  params: QuarantineParams
): Promise<QuarantineOutcome> {
  const { bucket, objectKey, status, detail, sha256 } = params;

  const recorded = await recordVerdict({ objectKey, status, detail, sha256 });
  const deleted = await deleteObjectSafely(bucket, objectKey, {
    status,
    detail,
  });

  if (deleted) {
    logger.warn("media-cleanup: rejected object removed from storage", {
      event: "media.quarantined",
      bucket,
      objectKey,
      status,
      detail,
    });
  } else {
    // The object was judged unsafe and is STILL in the bucket. Make that
    // visible on the row too, so an operator query finds it.
    await recordVerdict({
      objectKey,
      status,
      detail: `${detail ?? status}; STORAGE DELETE FAILED — object still present`,
      sha256,
    });
  }

  return { deleted, recorded };
}

/**
 * Persist a scan verdict to the MediaFile registry.
 *
 * This is what makes the verdict survive a Redis flush or TTL expiry.
 * `setScanStatus` existed with this exact docblock ("durable, survives Redis
 * TTL") and had zero production callers — every verdict went to Redis only, so
 * the durable column read `PENDING` for every row in the database and an
 * operator query for "find quarantined objects" returned nothing.
 *
 * Never throws: a registry write failure must not turn a successful rejection
 * into a 500.
 */
export async function recordVerdict(params: {
  objectKey: string;
  status: MediaScanStatus;
  detail?: string;
  sha256?: string;
}): Promise<boolean> {
  try {
    await mediaFileRepository.setScanStatus(
      params.objectKey,
      params.status,
      params.detail ?? null,
      params.sha256 ?? null
    );
    return true;
  } catch (err) {
    logger.error("media-cleanup: failed to persist scan verdict", {
      severity: "critical",
      event: "media.verdict_persist_failed",
      objectKey: params.objectKey,
      status: params.status,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
