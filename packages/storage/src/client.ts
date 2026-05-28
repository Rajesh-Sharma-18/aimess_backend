import { S3Client } from "@aws-sdk/client-s3";

/** S3/MinIO client handle used by all storage helpers. */
export type StorageClient = S3Client;

export type CreateStorageClientOptions = {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region: string;
  /** MinIO requires path-style addressing. */
  forcePathStyle?: boolean;
};

/**
 * Builds an S3Client configured for MinIO. The checksum flags are required for
 * MinIO presigned PUT to work with existing clients — do not drop them.
 */
export function createStorageClient(
  options: CreateStorageClientOptions
): StorageClient {
  return new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    credentials: {
      accessKeyId: options.accessKey,
      secretAccessKey: options.secretKey,
    },
    forcePathStyle: options.forcePathStyle ?? true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}
