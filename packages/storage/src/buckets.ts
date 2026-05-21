import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

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
