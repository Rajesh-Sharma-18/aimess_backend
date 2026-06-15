import type { MediaObject } from "@aimess/shared-types";

import type { MediaUrlStrategy } from "./media-url-strategy.js";
import {
  parseFileMetaFromObjectKey,
  parseObjectKeyFromStored,
} from "./object-key-parse.js";
import type { UploadUrlResult } from "./upload.js";

export interface ToMediaObjectInput {
  bucket: string;
  stored: string | null | undefined;
  prefixes: readonly string[];
  strategy: MediaUrlStrategy;
  fileName?: string | null;
  contentType?: string | null;
  size?: number | null;
  resolveDownload?: boolean;
}

/**
 * Resolves a stored value (object key or legacy/external URL) into a
 * {@link MediaObject}. External http(s) URLs are passed through as the download
 * URL; stored object keys are resolved via the supplied strategy.
 */
export async function toMediaObject(
  input: ToMediaObjectInput
): Promise<MediaObject> {
  const objectKey = parseObjectKeyFromStored(input.stored, {
    prefixes: input.prefixes,
    bucket: input.bucket,
  });

  if (objectKey === null) {
    const isHttp =
      typeof input.stored === "string" && /^https?:\/\//i.test(input.stored);

    return {
      fileId: null,
      objectKey: null,
      fileName: input.fileName ?? null,
      contentType: input.contentType ?? null,
      size: input.size ?? null,
      downloadUrl: isHttp ? input.stored! : null,
      downloadUrlExpiresIn: null,
      uploadUrl: null,
      uploadUrlExpiresIn: null,
    };
  }

  const { fileId } = parseFileMetaFromObjectKey(objectKey);

  let url: string | null = null;
  let expiresIn: number | null = null;
  if (input.resolveDownload !== false) {
    try {
      const resolved = await input.strategy.resolveDownloadUrl(
        input.bucket,
        objectKey
      );
      url = resolved.url;
      expiresIn = resolved.expiresIn;
    } catch {
      url = null;
      expiresIn = null;
    }
  }

  return {
    fileId,
    objectKey,
    fileName: input.fileName ?? null,
    contentType: input.contentType ?? null,
    size: input.size ?? null,
    downloadUrl: url,
    downloadUrlExpiresIn: expiresIn,
    uploadUrl: null,
    uploadUrlExpiresIn: null,
  };
}

export function buildUploadMediaObject(input: {
  result: UploadUrlResult;
  contentType: string;
  fileName?: string | null;
}): MediaObject {
  const { fileId } = parseFileMetaFromObjectKey(input.result.objectKey);

  return {
    fileId,
    objectKey: input.result.objectKey,
    fileName: input.fileName ?? null,
    contentType: input.contentType,
    size: null,
    downloadUrl: null,
    downloadUrlExpiresIn: null,
    uploadUrl: input.result.uploadUrl,
    uploadUrlExpiresIn: input.result.uploadExpiresIn,
    uploadHeaders: input.result.headers,
  };
}
