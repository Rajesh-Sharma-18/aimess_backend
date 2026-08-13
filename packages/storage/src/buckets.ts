import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";

import type { StorageClient } from "./client.js";

export type ObjectHead = {
  exists: boolean;
  contentLength?: number;
  contentType?: string;
};

/**
 * HEAD a bucket as a cheap reachability check (health probes). Resolves on
 * success; rejects if the bucket is missing or the store is unreachable. Reads
 * nothing and creates nothing.
 */
export async function bucketExists(
  client: StorageClient,
  bucket: string
): Promise<void> {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
}

/** HEAD an object; returns `{ exists: false }` on 404, rethrows other errors. */
export async function headObject(
  client: StorageClient,
  bucket: string,
  key: string
): Promise<ObjectHead> {
  try {
    const result = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key })
    );

    return {
      exists: true,
      contentLength: result.ContentLength,
      contentType: result.ContentType,
    };
  } catch (err: unknown) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;
    if (status === 404) return { exists: false };
    throw err;
  }
}

/**
 * Download up to `maxBytes` from the beginning of an object for in-process
 * inspection (magic-byte check, virus scan). Uses a Range GET — only the
 * requested bytes are transferred, keeping the operation cheap for large files.
 *
 * Pass `maxBytes = Infinity` (or omit) to fetch the full object body. The
 * caller is responsible for memory budgeting.
 *
 * Returns `null` when the object does not exist or the response has no body.
 */
export async function getObjectBytes(
  client: StorageClient,
  bucket: string,
  key: string,
  maxBytes = Infinity
): Promise<Buffer | null> {
  try {
    const range =
      isFinite(maxBytes) && maxBytes > 0
        ? `bytes=0-${maxBytes - 1}`
        : undefined;

    const result = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, Range: range })
    );

    if (!result.Body) return null;

    // SDK v3 returns a ReadableStream/Readable depending on environment.
    const stream = result.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      );
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/**
 * Download the LAST `maxBytes` of an object.
 *
 * Needed because several containers keep their index at the end of the file: a
 * non-faststart MP4 (the default for phone-recorded video) carries its `moov`
 * atom — and with it duration and track dimensions — after all the media data,
 * and an Ogg stream's total sample count is the granule position of its final
 * page. Without a tail read those files simply report "duration unknown", which
 * silently skips the duration limit. A suffix Range keeps the transfer bounded
 * regardless of how large the object is.
 *
 * Returns `null` when the object does not exist or the range cannot be served.
 */
export async function getObjectTailBytes(
  client: StorageClient,
  bucket: string,
  key: string,
  maxBytes: number
): Promise<Buffer | null> {
  if (!(maxBytes > 0)) return null;
  try {
    const result = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: `bytes=-${Math.floor(maxBytes)}`,
      })
    );
    if (!result.Body) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of result.Body as Readable) {
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      );
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/** Delete an object (no-op safety left to caller). */
export async function deleteObject(
  client: StorageClient,
  bucket: string,
  key: string
): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * Ensure each bucket exists (creating when absent) and apply CORS so browsers
 * can PUT presigned upload URLs cross-origin. Without bucket-level CORS the
 * browser preflight (OPTIONS) gets no Access-Control-Allow-* headers and blocks
 * the PUT — the file never lands in MinIO even though the presigned URL is valid.
 *
 * Pass `allowedOrigins` (e.g. ["*"] in dev, explicit hosts in prod). CORS is
 * (re)applied on every startup so env changes take effect without manual mc CLI.
 */
export async function ensureBuckets(
  client: StorageClient,
  buckets: string[],
  allowedOrigins: string[] = ["*"]
): Promise<void> {
  for (const bucket of buckets) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    }

    // CORS is a best-effort enhancement for browser direct-to-MinIO presigned
    // PUT and MUST NOT abort bucket provisioning. PutBucketCors is a
    // checksum-mandatory S3 op, so the AWS SDK attaches an x-amz-checksum-crc32
    // header even with requestChecksumCalculation:"WHEN_REQUIRED" — and MinIO
    // builds that don't implement it reject the call with `501 NotImplemented`
    // ("a header you provided implies functionality that is not implemented").
    // Some MinIO versions also don't support PutBucketCors at all. Previously
    // that single failure threw out of ensureBuckets, so the whole service
    // logged "MinIO unavailable" and disabled uploads/downloads even though the
    // bucket itself was healthy. Swallow it: such deployments configure CORS via
    // server config (MINIO_API_CORS_ALLOW_ORIGIN) instead.
    try {
      await client.send(
        new PutBucketCorsCommand({
          Bucket: bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: allowedOrigins,
                AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
                AllowedHeaders: ["*"],
                ExposeHeaders: ["ETag", "Content-Length"],
                MaxAgeSeconds: 3600,
              },
            ],
          },
        })
      );
    } catch (err: unknown) {
      console.warn(
        `[storage] PutBucketCors skipped for bucket "${bucket}" — bucket is ready, ` +
          `but CORS was not applied via the S3 API (MinIO may not support it or ` +
          `rejected the SDK checksum header). If browser presigned uploads fail ` +
          `cross-origin, set MINIO_API_CORS_ALLOW_ORIGIN on the MinIO server. ` +
          `Cause: ${(err as Error)?.message ?? String(err)}`
      );
    }
  }
}
