import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";

import { logger } from "@aimess/logger";

import {
  ALLOWED_AVATAR_CONTENT_TYPES,
  type AllowedAvatarContentType,
  buildAvatarObjectKey,
} from "../lib/avatar-storage.js";
import {
  assertAvatarFileSize,
  AvatarMediaLimits,
} from "../lib/media-limits.js";
import { StorageBuckets } from "../lib/storage-buckets.js";
import { env } from "./env.js";

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: env.MINIO_ENDPOINT,
      region: env.MINIO_REGION,
      credentials: {
        accessKeyId: env.MINIO_ACCESS_KEY,
        secretAccessKey: env.MINIO_SECRET_KEY,
      },
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return s3Client;
}

export async function ensureStorageBuckets(): Promise<void> {
  const client = getS3Client();
  const buckets = Object.values(StorageBuckets);

  for (const bucket of buckets) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      logger.info(`MinIO bucket created: ${bucket}`);
    }
  }
}

/** Short-lived read URL for a private object (bucket stays private). */
export async function createAvatarViewUrl(objectKey: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: StorageBuckets.avatars,
    Key: objectKey,
  });

  return getSignedUrl(getS3Client(), command, {
    expiresIn: env.MINIO_AVATAR_VIEW_EXPIRES_IN,
  });
}

export function getAvatarViewUrlExpiresIn(): number {
  return env.MINIO_AVATAR_VIEW_EXPIRES_IN;
}

export async function createAvatarUploadPresignedUrl(params: {
  userId: string;
  contentType: AllowedAvatarContentType;
  contentLength: number;
}): Promise<{
  uploadUrl: string;
  objectKey: string;
  uploadExpiresIn: number;
  maxBytes: number;
  headers: { "Content-Type": string };
}> {
  assertAvatarFileSize(params.contentLength);

  const bucket = StorageBuckets.avatars;
  const extension = ALLOWED_AVATAR_CONTENT_TYPES[params.contentType];
  const objectKey = buildAvatarObjectKey(
    params.userId,
    randomUUID(),
    extension
  );
  const uploadExpiresIn = env.MINIO_PRESIGN_EXPIRES_IN;

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    ContentType: params.contentType,
  });

  const uploadUrl = await getSignedUrl(getS3Client(), command, {
    expiresIn: uploadExpiresIn,
  });

  return {
    uploadUrl,
    objectKey,
    uploadExpiresIn,
    maxBytes: AvatarMediaLimits.maxBytes,
    headers: {
      "Content-Type": params.contentType,
    },
  };
}

export type AvatarObjectHead = {
  exists: boolean;
  contentLength?: number;
  contentType?: string;
};

export async function headAvatarObject(
  objectKey: string
): Promise<AvatarObjectHead> {
  try {
    const result = await getS3Client().send(
      new HeadObjectCommand({
        Bucket: StorageBuckets.avatars,
        Key: objectKey,
      })
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

export async function deleteAvatarObject(objectKey: string): Promise<void> {
  await getS3Client().send(
    new DeleteObjectCommand({
      Bucket: StorageBuckets.avatars,
      Key: objectKey,
    })
  );
}
