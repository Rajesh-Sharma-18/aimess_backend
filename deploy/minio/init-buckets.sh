#!/bin/sh
# Create the buckets the services expect, and one scoped MinIO account per
# service. Idempotent — safe to re-run on every stack start.
#
# Bucket names are taken from apps/*/.env.example (MINIO_BUCKET_*). Keep the
# lists below in sync when a service introduces a new bucket, or its first
# upload fails with NoSuchBucket / AccessDenied.
#
# All buckets stay PRIVATE. Every read and write goes through a presigned URL
# minted by media-service / user-service / community-service / backoffice-service,
# so public anonymous access is never required and would leak user media.
#
# ## Why per-service accounts (AIM-25)
#
# Six services held the MinIO ROOT credentials. Root can read and delete every
# object in every bucket, create and drop buckets, and change server config, so
# a leak from ANY of the six — a log line, a crash dump, a `docker inspect`, one
# compromised container — handed over all user media at once and the ability to
# destroy it. Nothing about, say, stream-service's job requires the power to
# empty the avatars bucket.
#
# Each service now gets its own account, limited to the buckets it actually
# names in its own configuration. A leak from one service is then bounded by
# what that service was already allowed to do, and the root credentials stay
# with the operator.
set -eu

mc alias set local "${MINIO_INTERNAL_URL:-http://minio:9000}" \
  "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"

AVATARS="${MINIO_BUCKET_AVATARS:-aimess-avatars}"
CHAT="${MINIO_BUCKET_CHAT:-aimess-chat}"
COMMUNITY="${MINIO_BUCKET_COMMUNITY:-aimess-community}"
STREAM="${MINIO_BUCKET_STREAM:-aimess-stream}"

for bucket in "$AVATARS" "$CHAT" "$COMMUNITY" "$STREAM"; do
  if mc ls "local/${bucket}" >/dev/null 2>&1; then
    echo "bucket ${bucket} already exists"
  else
    mc mb "local/${bucket}"
    echo "created bucket ${bucket}"
  fi
  # Explicitly assert private access in case a bucket was created by hand.
  mc anonymous set none "local/${bucket}"
done

# ----------------------------------------------------------------------------
# Per-service accounts
# ----------------------------------------------------------------------------

POLICY_DIR="$(mktemp -d)"

# Write a policy granting full object access within the named buckets, and
# nothing outside them. `s3:ListBucket` is on the bucket ARN; the object verbs
# are on its contents, which is why each bucket contributes two resources.
write_policy() {
  name="$1"
  shift

  resources=""
  for bucket in "$@"; do
    resources="${resources}\"arn:aws:s3:::${bucket}\",\"arn:aws:s3:::${bucket}/*\","
  done
  resources="${resources%,}"

  cat > "${POLICY_DIR}/${name}.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketLocation"
      ],
      "Resource": [${resources}]
    }
  ]
}
EOF
}

# Create (or update) one service account. The secret comes from the environment
# so it is generated per deployment and never lives in this file.
#
# A missing secret is fatal rather than defaulted: silently falling back to a
# known value, or to root, is exactly the failure this replaces.
provision() {
  service="$1"
  secret_var="$2"
  shift 2

  secret="$(printenv "$secret_var" || true)"
  if [ -z "$secret" ]; then
    echo "refusing to provision ${service}: ${secret_var} is not set" >&2
    exit 1
  fi

  write_policy "$service" "$@"
  mc admin policy create local "$service" "${POLICY_DIR}/${service}.json" \
    >/dev/null 2>&1 || mc admin policy create local "$service" "${POLICY_DIR}/${service}.json"

  if mc admin user info local "$service" >/dev/null 2>&1; then
    # Re-applying the secret keeps a rotation in the environment authoritative.
    mc admin user add local "$service" "$secret" >/dev/null
    echo "updated account ${service}"
  else
    mc admin user add local "$service" "$secret" >/dev/null
    echo "created account ${service}"
  fi

  mc admin policy attach local "$service" --user "$service" >/dev/null 2>&1 || true
  echo "  scoped to: $*"
}

# Bucket lists mirror each service's own MINIO_BUCKET_* configuration. A service
# that does not name a bucket has no business reaching it.
provision aimess-media      MINIO_SECRET_MEDIA      "$AVATARS" "$CHAT" "$COMMUNITY" "$STREAM"
provision aimess-user       MINIO_SECRET_USER       "$AVATARS"
provision aimess-chat       MINIO_SECRET_CHAT       "$CHAT" "$AVATARS" "$COMMUNITY"
provision aimess-community  MINIO_SECRET_COMMUNITY  "$COMMUNITY" "$AVATARS"
provision aimess-stream     MINIO_SECRET_STREAM     "$AVATARS" "$STREAM"
provision aimess-backoffice MINIO_SECRET_BACKOFFICE "$AVATARS" "$COMMUNITY" "$STREAM"

rm -rf "$POLICY_DIR"

echo "buckets and per-service accounts ready."
