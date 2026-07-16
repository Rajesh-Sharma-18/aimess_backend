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
      });

      return { url, expiresIn: opts.defaultViewExpiresIn };
    },
  };
}
