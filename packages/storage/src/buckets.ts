import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";

import type { StorageClient } from "./client.js";

export type ObjectHead = {
  exists: boolean;
  contentLength?: number;
  contentType?: string;
};

/** HEAD an object; returns `{ exists: false }` on any error (incl. 404). */
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
  } catch {
    return { exists: false };
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

/** Delete an object (no-op safety left to caller). */
export async function deleteObject(
  client: StorageClient,
  bucket: string,
  key: string
): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** Ensure each bucket exists, creating it when the HEAD probe fails. */
export async function ensureBuckets(
  client: StorageClient,
  buckets: string[]
): Promise<void> {
  for (const bucket of buckets) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  }
}
