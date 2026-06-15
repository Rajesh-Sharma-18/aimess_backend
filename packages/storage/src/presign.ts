import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { StorageClient } from "./client.js";

export type CreatePresignedUploadUrlParams = {
  client: StorageClient;
  bucket: string;
  objectKey: string;
  contentType: string;
  expiresIn: number;
};

/**
 * Presigned PUT URL. Signs ONLY Content-Type (no Content-Length) so existing
 * clients that PUT with just the Content-Type header keep working.
 */
export async function createPresignedUploadUrl(
  params: CreatePresignedUploadUrlParams
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: params.bucket,
    Key: params.objectKey,
    ContentType: params.contentType,
  });

  return getSignedUrl(params.client, command, {
    expiresIn: params.expiresIn,
  });
}

export type CreatePresignedViewUrlParams = {
  client: StorageClient;
  bucket: string;
  objectKey: string;
  expiresIn: number;
  /**
   * Optional S3 response-header overrides baked into the presigned GET. Used for
   * safe-serving (e.g. `attachment; filename="…"` to force download of
   * documents). Omitted → the object is served with its stored headers (current
   * behavior), so every existing caller is unaffected.
   */
  responseContentDisposition?: string;
  responseContentType?: string;
};

/** Short-lived presigned GET URL for a private object. */
export async function createPresignedViewUrl(
  params: CreatePresignedViewUrlParams
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: params.bucket,
    Key: params.objectKey,
    ResponseContentDisposition: params.responseContentDisposition,
    ResponseContentType: params.responseContentType,
  });

  return getSignedUrl(params.client, command, {
    expiresIn: params.expiresIn,
  });
}
