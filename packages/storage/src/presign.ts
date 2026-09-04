import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { StorageClient } from "./client.js";

export type CreatePresignedUploadUrlParams = {
  client: StorageClient;
  bucket: string;
  objectKey: string;
  contentType: string;
  expiresIn: number;
  /**
   * Exact byte count the client declared. Signed into the URL, so the upload
   * must carry a matching `Content-Length`.
   */
  contentLength?: number;
};

/**
 * Presigned PUT URL.
 *
 * `ContentLength` is part of the signature. Without it, the declared size was
 * validated server-side and then never enforced anywhere: the returned URL let
 * the holder PUT an arbitrary number of gigabytes, and nothing server-side
 * could refuse the write. The real size was first observed at `/media/confirm`
 * — after the bytes were already stored and paid for — and a client that simply
 * never called confirm left them there until the orphan sweep. Combined with
 * the per-user media limiter, that was a bucket-filling and egress-exhaustion
 * primitive from one account.
 *
 * Signing it means the client must send that exact `Content-Length`. Browsers
 * and the mobile SDKs always set it on a PUT with a known body, so this is not
 * a new client requirement — it makes the number the client already sends
 * binding instead of advisory.
 */
export async function createPresignedUploadUrl(
  params: CreatePresignedUploadUrlParams
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: params.bucket,
    Key: params.objectKey,
    ContentType: params.contentType,
    ...(params.contentLength !== undefined
      ? { ContentLength: params.contentLength }
      : {}),
  });

  return getSignedUrl(params.client, command, {
    expiresIn: params.expiresIn,
    // Both headers must be SIGNED, not merely sent: an unsigned header is one
    // the client can change after the fact.
    signableHeaders: new Set(
      params.contentLength !== undefined
        ? ["content-type", "content-length"]
        : ["content-type"]
    ),
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
