/**
 * Send-time attachment verification.
 *
 * The gap this closes: chat-service accepted an arbitrary `objectKey` on a
 * message and never checked anything about it. Nothing verified that the object
 * existed, that the SENDER uploaded it, that it belonged to the room being
 * posted to, or that it had passed media-service's security pipeline — and
 * because the read path (`lib/media-resolve.ts`) presigns MinIO directly rather
 * than going through `/media/download-url`, media-service's scan gate was never
 * consulted for a chat attachment at all. The only send-time checks were byte
 * size and duration read from CLIENT-SUPPLIED fields, both trivially omitted:
 * `size` defaults to 0 and `durationMs` to undefined, so both caps self-disabled.
 *
 * Three things are verified here, in one batched round trip per send:
 *
 *   1. **Verified** — the object passed structural validation and the AV scan
 *      (`downloadable`, i.e. CLEAN or SKIPPED). Anything else, including an
 *      object media-service has never heard of, is refused.
 *   2. **Owned** — the registry's `ownerId` is the sender. Stops a user
 *      attaching someone else's object by guessing or replaying a key.
 *   3. **Scoped** — the registry's `resourceId` is the room being posted to.
 *      Stops an attachment uploaded for room A being re-posted into room B,
 *      which would hand it to a completely different audience.
 *
 * FAIL CLOSED. A media-service outage rejects the send with a retryable error
 * rather than persisting a reference nothing has vouched for.
 *
 * External http(s) values (Giphy/Tenor stickers and GIFs) are passed through:
 * there is no object behind them, nothing was uploaded, and they are already
 * served from a third-party origin. They are a separate concern from this gate.
 */

import { BadRequestError, ServiceUnavailableError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import { getMediaVerifyClient } from "../grpc/media.client.js";

/** The attachment fields this guard reads. Everything else is ignored. */
export interface VerifiableAttachment {
  objectKey?: unknown;
  url?: unknown;
  thumbnailObjectKey?: unknown;
  [key: string]: unknown;
}

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/** Every storage key an attachment references (the object plus its poster frame). */
function storageKeysOf(file: VerifiableAttachment): string[] {
  const keys: string[] = [];
  for (const candidate of [file.objectKey, file.thumbnailObjectKey, file.url]) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    if (isHttpUrl(candidate)) continue; // external provider — not our object
    keys.push(candidate);
  }
  return keys;
}

export interface AssertAttachmentsVerifiedParams {
  /** The room / group / community the message is being posted to. */
  resourceId: string;
  /** The authenticated sender. */
  senderId: string;
  files: VerifiableAttachment[] | undefined | null;
  /** Extra single attachments outside `files[]` (e.g. `content.sticker`). */
  extra?: Array<VerifiableAttachment | null | undefined>;
}

/**
 * Throws unless every uploaded object referenced by the message is verified,
 * owned by the sender, and scoped to this room.
 */
export async function assertAttachmentsVerified(
  params: AssertAttachmentsVerifiedParams
): Promise<void> {
  if (!env.CHAT_MEDIA_VERIFY_ENABLED) return;

  const candidates: VerifiableAttachment[] = [
    ...(Array.isArray(params.files) ? params.files : []),
    ...(params.extra ?? []).filter(
      (f): f is VerifiableAttachment => !!f && typeof f === "object"
    ),
  ];

  const keys = Array.from(new Set(candidates.flatMap(storageKeysOf)));
  if (keys.length === 0) return;

  let statuses;
  try {
    statuses = await getMediaVerifyClient().checkMediaStatus(keys);
  } catch (err) {
    logger.warn("attachment-guard: media-service unreachable — refusing send", {
      resourceId: params.resourceId,
      senderId: params.senderId,
      keyCount: keys.length,
      error: err instanceof Error ? err.message : String(err),
    });
    // Retryable, not a 4xx: the request is well-formed, we just cannot vouch
    // for the file right now.
    throw new ServiceUnavailableError("MEDIA_REGISTRY_UNAVAILABLE");
  }

  for (const objectKey of keys) {
    const entry = statuses.get(objectKey);

    if (!entry || !entry.scanStatus) {
      // Unknown to media-service: either never uploaded through the pipeline, or
      // uploaded and never confirmed.
      logSecurityRejection("unknown", objectKey, params);
      throw new BadRequestError("MEDIA_NOT_VERIFIED");
    }

    if (!entry.downloadable) {
      logSecurityRejection(entry.scanStatus, objectKey, params);
      throw new BadRequestError(
        entry.scanStatus === "INFECTED" || entry.scanStatus === "QUARANTINED"
          ? "MEDIA_MALWARE_DETECTED"
          : entry.scanStatus === "REJECTED"
            ? "MEDIA_SECURITY_VALIDATION_FAILED"
            : "MEDIA_NOT_VERIFIED"
      );
    }

    if (entry.ownerId && entry.ownerId !== params.senderId) {
      logSecurityRejection("foreign-owner", objectKey, params);
      throw new BadRequestError("CHAT_MEDIA_FORBIDDEN");
    }

    // `resourceId` is only recorded for the membership-scoped chat categories;
    // an avatar has none, so an empty value is not a mismatch.
    if (entry.resourceId && entry.resourceId !== params.resourceId) {
      logSecurityRejection("foreign-resource", objectKey, params);
      throw new BadRequestError("CHAT_MEDIA_FORBIDDEN");
    }
  }
}

function logSecurityRejection(
  reason: string,
  objectKey: string,
  params: AssertAttachmentsVerifiedParams
): void {
  logger.warn("media-security", {
    event: "media.attachment_unverified",
    reason,
    objectKey,
    senderId: params.senderId,
    resourceId: params.resourceId,
    at: new Date().toISOString(),
  });
}
