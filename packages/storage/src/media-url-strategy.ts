import type { StorageClient } from "./client.js";
import { createPresignedViewUrl } from "./presign.js";

export interface MediaUrlStrategy {
  resolveDownloadUrl(
    bucket: string,
    objectKey: string
  ): Promise<{ url: string; expiresIn: number | null }>;
}

export interface CreateMediaUrlStrategyOptions {
  client: StorageClient;
  defaultViewExpiresIn: number;
  cdnBaseUrl?: string | null;
}

/**
 * Extensions whose STORED Content-Type no browser will play, even though the
 * bytes are an ISOBMFF stream every browser can demux. QuickTime (.mov) and
 * .m4v are the same container family as MP4 — only the label differs — and a
 * `<video>` served `video/quicktime` is rejected by Chrome/Firefox before a
 * single byte is decoded, which is exactly the "play button does nothing"
 * symptom for an iPhone-recorded H.264/AAC clip.
 *
 * Overriding the response Content-Type on the presigned GET is the whole fix
 * for that case, and it lives HERE — the single choke point every resolve-on-read
 * presign goes through — rather than in any one caller.
 *
 * Genuinely foreign containers (mkv, avi) are deliberately NOT listed:
 * relabelling those would trade "won't play" for "plays garbage". They need
 * real transcoding, and until that exists the client renders an unsupported-format
 * notice instead.
 */
const PLAYBACK_CONTENT_TYPE_BY_EXT: Record<string, string> = {
  mov: "video/mp4",
  m4v: "video/mp4",
};

/** Response Content-Type override to force for `objectKey`, if any. */
export function playbackContentTypeForKey(
  objectKey: string
): string | undefined {
  const ext = objectKey.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  return PLAYBACK_CONTENT_TYPE_BY_EXT[ext];
}

/**
 * Builds a strategy that resolves download URLs for stored objects. When a CDN
 * base URL is configured it returns a stable CDN URL (no signing); otherwise it
 * falls back to a short-lived presigned GET URL — byte-identical in shape to
 * today's presigned-GET behavior.
 */
export function createMediaUrlStrategy(
  opts: CreateMediaUrlStrategyOptions
): MediaUrlStrategy {
  return {
    async resolveDownloadUrl(bucket: string, objectKey: string) {
      // Callers are expected to filter out already-full URLs (see
      // isHttpUrl checks in media-object.ts / chat-service's media-resolve.ts)
      // before reaching here, but a raw http(s) value must never be
      // re-prefixed with the CDN base — pass it through unchanged so a
      // mis-routed external URL (e.g. Giphy/Tenor) can't become
      // `<cdnBaseUrl>/https://...`.
      if (/^https?:\/\//i.test(objectKey)) {
        return { url: objectKey, expiresIn: null };
      }

      if (opts.cdnBaseUrl) {
        return {
          url: `${opts.cdnBaseUrl.replace(/\/$/, "")}/${objectKey}`,
          expiresIn: null,
        };
      }

      const url = await createPresignedViewUrl({
        client: opts.client,
        bucket,
        objectKey,
        expiresIn: opts.defaultViewExpiresIn,
        responseContentType: playbackContentTypeForKey(objectKey),
      });

      return { url, expiresIn: opts.defaultViewExpiresIn };
    },
  };
}
