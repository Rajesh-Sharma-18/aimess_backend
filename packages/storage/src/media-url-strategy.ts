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
