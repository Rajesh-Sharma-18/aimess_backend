#!/usr/bin/env bash
# Build the application images ON THE SERVER from checked-out source.
#
#   bash 06-build-images.sh dev02 /opt/aimess/aimess_backend
#   bash 06-build-images.sh dev01 /opt/aimess/aimess_backend /opt/aimess/aimess_website
#
# Building here rather than pulling from a registry avoids standing up a
# registry and deploy tokens. .gitlab-ci.yml already publishes three images if
# you would rather pull — see docker/README.md — but the placeholder registry
# path in docker/compose.deploy.example.yml must be replaced first.
#
# Each build is a full monorepo install and takes several minutes. Both hosts
# have 4 vCPU / 15 GB RAM, which is comfortable for this.
set -euo pipefail

ROLE="${1:-}"
BACKEND_DIR="${2:-}"
FRONTEND_DIR="${3:-}"

if [ "$ROLE" != "dev01" ] && [ "$ROLE" != "dev02" ]; then
  echo "usage: bash 06-build-images.sh <dev01|dev02> <backend-dir> [frontend-dir]" >&2
  exit 1
fi

if [ "$ROLE" = "dev02" ]; then
  # Every service that runs on Dev 02 — stream-service included, because the
  # stream server turned out to run only SRS (verified 2026-08-06).
  SERVICES=(api-gateway auth-service user-service community-service chat-service
            notifications-service media-service stream-service backoffice-service)
  FRONTEND_IMAGE=aimess-admin-panel
else
  SERVICES=()
  FRONTEND_IMAGE=aimess-website
fi

if [ ${#SERVICES[@]} -gt 0 ]; then
  [ -d "$BACKEND_DIR" ] || { echo "ERROR: backend dir not found: $BACKEND_DIR" >&2; exit 1; }
  cd "$BACKEND_DIR"

  echo "==> building ${#SERVICES[@]} backend images"
  for s in "${SERVICES[@]}"; do
    echo
    echo "--- $s ---"
    # Context MUST be the repo root (`.`), not the app directory — the
    # Dockerfiles run `pnpm install` across the whole workspace.
    docker build -f "apps/$s/Dockerfile" -t "aimess-$s:latest" .
  done
fi

if [ -n "$FRONTEND_DIR" ]; then
  [ -d "$FRONTEND_DIR" ] || { echo "ERROR: frontend dir not found: $FRONTEND_DIR" >&2; exit 1; }

  # NEXT_PUBLIC_* values are inlined into the browser bundle at BUILD time, so
  # this file must exist and be correct BEFORE the image is built. Setting them
  # in compose later has no effect whatsoever.
  if [ ! -f "$FRONTEND_DIR/.env.production" ]; then
    echo "ERROR: $FRONTEND_DIR/.env.production is missing." >&2
    echo "       Create it first — see the header comment in that repo's Dockerfile" >&2
    echo "       for the required NEXT_PUBLIC_* keys. Building without it produces" >&2
    echo "       an image that silently points at localhost." >&2
    exit 1
  fi

  echo
  echo "--- $FRONTEND_IMAGE ---"
  docker build -t "$FRONTEND_IMAGE:latest" "$FRONTEND_DIR"
fi

echo
echo "==> images built"
docker images --filter 'reference=aimess-*' --format '  {{.Repository}}:{{.Tag}}  {{.Size}}  {{.CreatedSince}}'
