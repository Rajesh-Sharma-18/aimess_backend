/**
 * Shared avatar/community-image → {@link MediaObject} resolvers. This is the
 * project's single reusable avatar mapper — reused by every admin repository
 * that needs to resolve a stored avatar key/url (community list/detail, user
 * management, livestream list/detail, …). Do NOT duplicate this logic inline;
 * import from here.
 *
 * Lives in `lib/` (not `community.grpc.repository.ts`) specifically so
 * non-community repositories (e.g. livestream) can import it without creating
 * a module cycle back through `community.repository.ts`.
 */
import {
  MEDIA_PREFIXES,
  parseFileMetaFromObjectKey,
  toMediaObject,
} from "@aimess/storage";
import type { MediaObject } from "@aimess/shared-types";

import { mediaUrlStrategy } from "../config/storage.js";
import { env } from "../config/env.js";

const AVATAR_BUCKET = env.MINIO_BUCKET_AVATARS;
const AVATAR_PREFIXES = MEDIA_PREFIXES.avatars;

/**
 * Stored avatar key/url → the standard {@link MediaObject} (see
 * @aimess/shared-types) used across User APIs / Community Details / Livestream
 * List — the project's single reusable avatar shape. Null/absent input yields
 * an all-null MediaObject (toMediaObject's own contract). `toMediaObject`
 * passes an already-signed http(s) URL through unchanged, so resolving a value
 * that's already a presigned URL (e.g. from an upstream gRPC snapshot) is an
 * idempotent safety net, not a re-sign.
 */
export async function resolveAvatarMediaObject(
  stored: string | null | undefined
): Promise<MediaObject> {
  return toMediaObject({
    bucket: AVATAR_BUCKET,
    stored: stored ?? null,
    prefixes: AVATAR_PREFIXES,
    strategy: mediaUrlStrategy,
  });
}

/** Stored avatar key/url → presigned download URL (null when absent). */
export async function resolveAvatarUrl(
  stored: string | null | undefined
): Promise<string | null> {
  const media = await resolveAvatarMediaObject(stored);
  return media.downloadUrl;
}

const COMMUNITY_BUCKET = env.MINIO_BUCKET_COMMUNITY;
const COMMUNITY_IMAGE_PREFIXES = MEDIA_PREFIXES.community;

/**
 * Stored community avatar/cover key/url → the standard {@link MediaObject}
 * (community bucket). Mirrors {@link resolveAvatarMediaObject} but for the
 * community image bucket. Null/absent input yields an all-null MediaObject
 * (toMediaObject's own contract).
 */
export async function resolveCommunityImageMediaObject(
  stored: string | null | undefined
): Promise<MediaObject> {
  return toMediaObject({
    bucket: COMMUNITY_BUCKET,
    stored: stored ?? null,
    prefixes: COMMUNITY_IMAGE_PREFIXES,
    strategy: mediaUrlStrategy,
  });
}

/** Stored community avatar/cover key/url → presigned download URL (null when absent). */
export async function resolveCommunityImageUrl(
  stored: string | null | undefined
): Promise<string | null> {
  const media = await resolveCommunityImageMediaObject(stored);
  return media.downloadUrl;
}

/**
 * Collapses the all-null {@link MediaObject} `toMediaObject` returns for an
 * absent avatar into a bare `null` — the project-wide response contract for
 * "no avatar" is `"avatar": null`, not an object of null fields. Reused by
 * every admin API that exposes an `avatar` field so the null-collapse logic
 * lives in exactly one place.
 */
export function toAvatarOrNull(media: MediaObject): MediaObject | null {
  return media.objectKey === null && media.downloadUrl === null ? null : media;
}

/** `resolveAvatarMediaObject` + {@link toAvatarOrNull} in one call. */
export async function resolveAvatarOrNull(
  stored: string | null | undefined
): Promise<MediaObject | null> {
  return toAvatarOrNull(await resolveAvatarMediaObject(stored));
}

/** `resolveCommunityImageMediaObject` + {@link toAvatarOrNull} in one call. */
export async function resolveCommunityImageOrNull(
  stored: string | null | undefined
): Promise<MediaObject | null> {
  return toAvatarOrNull(await resolveCommunityImageMediaObject(stored));
}

const STREAM_BUCKET = env.MINIO_BUCKET_STREAM;

/**
 * Stream thumbnail object key → {@link MediaObject} (stream bucket). Stream
 * thumbnails aren't covered by `MEDIA_PREFIXES` (no `stream/` prefix bucket
 * exists there), so this resolves the bare key directly against the stream
 * bucket instead of going through `toMediaObject`'s prefix-matching — same
 * approach `livestream.repository.ts`'s `resolveThumb` uses, just returning
 * the full MediaObject shape (this endpoint's contract) instead of a bare URL.
 * Null when there's no stored key or the presign fails.
 */
export async function resolveStreamThumbnailOrNull(
  key: string | null | undefined
): Promise<MediaObject | null> {
  if (!key) return null;
  try {
    const { url, expiresIn } = await mediaUrlStrategy.resolveDownloadUrl(
      STREAM_BUCKET,
      key
    );
    const { fileId } = parseFileMetaFromObjectKey(key);
    return {
      mediaId: null,
      fileId,
      objectKey: key,
      fileName: null,
      contentType: null,
      size: null,
      downloadUrl: url,
      downloadUrlExpiresIn: expiresIn,
      uploadUrl: null,
      uploadUrlExpiresIn: null,
    };
  } catch {
    return null;
  }
}
