#!/bin/sh
# Create the buckets the services expect, idempotently.
#
# Bucket names are taken from apps/*/.env.example (MINIO_BUCKET_*). Keep this
# list in sync when a service introduces a new bucket, or its first upload
# fails with NoSuchBucket.
#
# All buckets stay PRIVATE. Every read and write goes through a presigned URL
# minted by media-service / user-service / community-service / backoffice-service,
# so public anonymous access is never required and would leak user media.
set -eu

mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"

for bucket in aimess-avatars aimess-chat aimess-community aimess-stream; do
  if mc ls "local/${bucket}" >/dev/null 2>&1; then
    echo "bucket ${bucket} already exists"
  else
    mc mb "local/${bucket}"
    echo "created bucket ${bucket}"
  fi
  # Explicitly assert private access in case a bucket was created by hand.
  mc anonymous set none "local/${bucket}"
done

echo "buckets ready."
