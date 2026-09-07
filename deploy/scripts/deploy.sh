#!/usr/bin/env bash
# ============================================================================
# deploy.sh — build, verify, swap, clean up. One target per run.
#
#   bash deploy/scripts/deploy.sh <target> [--pull] [--no-cache]
#
# Targets
#   api-gateway  auth-service  user-service  community-service  chat-service
#   notifications-service  media-service  stream-service  backoffice-service
#   all-backend   every service above, each as its own independent cycle
#   website       Next.js site   (Dev 01, 76.13.216.164)
#   admin         Next.js admin  (Dev 02, 76.13.216.171)
#
# Flags
#   --pull       git fetch + reset --hard origin/staging before building
#   --no-cache   pass --no-cache to docker build
#
# ---------------------------------------------------------------------------
# ORDER OF OPERATIONS — this is the entire point of the script
#
#   1. Refuse to start unless the disk can actually hold a build. Reclaims
#      first, then re-checks. A build that dies on a full disk is what took
#      the box down, and it leaves its mess behind rather than cleaning up.
#   2. Build to a throwaway tag :new. The running container and :latest are
#      NOT touched. A build failure at this point changes nothing at all —
#      the old container keeps serving and :latest still points at it.
#   3. Only once the build has succeeded:  :latest -> :prev,  :new -> :latest
#   4. Recreate the container, then poll its own /health until it answers.
#   5. Health fails -> :prev restored to :latest, container brought back,
#      failing logs printed, exit 1.
#      Health passes -> the image from two deploys ago is now untagged, so it
#      is pruned. Exactly one rollback generation is kept, forever.
#
# Manual rollback is always available for one generation:
#   docker tag aimess-<svc>:prev aimess-<svc>:latest
#   cd <compose dir> && docker compose --env-file <env file> up -d <service>
#
# NOTE ON THE PUBLIC-URL CHECK: it is advisory and never triggers a rollback.
# The decisive signal is the container's own /health. Rolling back a good
# build because Cloudflare or HAProxy hiccuped would be worse than the hiccup.
# ============================================================================
set -euo pipefail

TARGET="${1:-}"
shift || true

DO_PULL=0
NO_CACHE=""
for arg in "$@"; do
  case "$arg" in
    --pull)     DO_PULL=1 ;;
    --no-cache) NO_CACHE="--no-cache" ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

# Free space / inodes required before a build may start. One builder stage is
# a full 993-package workspace install (~3-4 GB) plus the pnpm deploy output,
# and pnpm creates a very large number of small files — inode exhaustion
# reports the same ENOSPC errno as a full disk, so both are checked.
MIN_FREE_GB="${MIN_FREE_GB:-15}"
MIN_FREE_INODES="${MIN_FREE_INODES:-500000}"

BACKEND_DIR="${BACKEND_DIR:-/opt/aimess/aimess_backend}"
DEV01="76.13.216.164"
DEV02="76.13.216.171"

BACKEND_SERVICES=(api-gateway auth-service user-service community-service
                  chat-service notifications-service media-service
                  stream-service backoffice-service)

# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

DOCKER_ROOT="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
free_gb() { df -PBG "$DOCKER_ROOT" | awk 'NR==2 {gsub(/G/,"",$4); print $4+0}'; }

# btrfs and zfs report "-" (which awk turns into 0) because they have no fixed
# inode table. Returning 0 there would make the preflight refuse to ever build,
# so an unreportable count is treated as "not applicable" rather than "empty".
free_inodes() { df -Pi "$DOCKER_ROOT" | awk 'NR==2 {print $4+0}'; }
inodes_known() { [ "$(free_inodes)" -gt 0 ]; }

disk_line() {
  if inodes_known; then
    printf '    %s: %sG free, %s inodes free\n' "$DOCKER_ROOT" "$(free_gb)" "$(free_inodes)"
  else
    printf '    %s: %sG free (inode count not reported by this filesystem)\n' "$DOCKER_ROOT" "$(free_gb)"
  fi
}

# Safe to call at any time: only ever removes build cache and images that
# nothing references. Never touches volumes — clamav_data on Dev 02 and the
# postgres/mongodb/minio/rabbitmq volumes on Dev 01 live there.
reclaim() {
  say "    reclaiming: build cache + dangling images"
  docker builder prune -af  >/dev/null 2>&1 || true
  docker image     prune -f >/dev/null 2>&1 || true
  docker container prune -f >/dev/null 2>&1 || true
}

# --------------------------------------------------------------------------
# target table
# --------------------------------------------------------------------------
resolve_target() {
  KIND=backend
  BUILD_CTX="$BACKEND_DIR"
  COMPOSE_DIR="$BACKEND_DIR/deploy/dev02"
  ENV_FILE=".env.dev02"
  EXPECT_HOST="$DEV02"
  HEALTH_PATH="/health"
  HOST_PORT=""
  PUBLIC_URL=""

  case "$1" in
    api-gateway)           SVC=api-gateway;           PORT=3000; HOST_PORT=3000; PUBLIC_URL=https://api.ai5dev.tech/health ;;
    auth-service)          SVC=auth-service;          PORT=3001 ;;
    user-service)          SVC=user-service;          PORT=3002 ;;
    community-service)     SVC=community-service;     PORT=3003 ;;
    chat-service)          SVC=chat-service;          PORT=3004; HOST_PORT=3004 ;;
    notifications-service) SVC=notifications-service; PORT=3006 ;;
    stream-service)        SVC=stream-service;        PORT=3007 ;;
    media-service)         SVC=media-service;         PORT=3009 ;;
    backoffice-service)    SVC=backoffice-service;    PORT=3010; HOST_PORT=3010; PUBLIC_URL=https://backoffice.ai5dev.tech/health ;;

    website)
      KIND=frontend
      SVC=website
      BUILD_CTX="${WEBSITE_DIR:-/opt/aimess/aimess_website}"
      COMPOSE_DIR="$BACKEND_DIR/deploy/dev01"
      ENV_FILE=".env.dev01"
      EXPECT_HOST="$DEV01"
      PORT=3000; HOST_PORT=3000
      HEALTH_PATH="/"
      PUBLIC_URL=https://ai5dev.tech/
      ;;
    admin|admin-panel)
      KIND=frontend
      SVC=admin-panel
      BUILD_CTX="${ADMIN_DIR:-/opt/aimess/aimess_admin_panel}"
      PORT=3000; HOST_PORT=3011
      HEALTH_PATH="/"
      PUBLIC_URL=https://admin.ai5dev.tech/
      ;;
    *) return 1 ;;
  esac

  IMAGE="aimess-$SVC"
  CONTAINER="aimess-$SVC"
  DOCKERFILE="$BACKEND_DIR/apps/$SVC/Dockerfile"
}

# --------------------------------------------------------------------------
# health probing
# --------------------------------------------------------------------------
# Every backend service exposes GET /health, but only api-gateway, chat and
# backoffice publish a host port — the rest are reachable only on the compose
# bridge. Probing those means issuing the request from inside the container.
# The images are node:22-based and Node 22 ships a global fetch, so nothing
# extra needs installing.
probe_once() {
  local code
  if [ -n "$HOST_PORT" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
             "http://127.0.0.1:${HOST_PORT}${HEALTH_PATH}" 2>/dev/null || echo 000)
    if [ "$KIND" = frontend ]; then
      # A Next.js root may legitimately redirect (admin -> /login).
      case "$code" in 2??|3??) return 0 ;; *) return 1 ;; esac
    fi
    [ "$code" = "200" ]
  else
    docker exec "$CONTAINER" node -e \
      "fetch('http://127.0.0.1:${PORT}${HEALTH_PATH}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1
  fi
}

wait_healthy() {
  local tries="${1:-30}" i status
  for i in $(seq 1 "$tries"); do
    if probe_once; then say "    healthy after ${i} attempt(s)"; return 0; fi
    # A container that has already given up is not going to recover.
    status=$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
    if [ "$status" = "exited" ]; then say "    container exited"; return 1; fi
    sleep 3
  done
  return 1
}

# --------------------------------------------------------------------------
# frontend env sanity
# --------------------------------------------------------------------------
# NEXT_PUBLIC_* is inlined into the JavaScript bundle at build time, so a wrong
# value here is not a runtime misconfiguration you can correct afterwards — it
# is compiled into the artifact and only another full rebuild removes it. These
# checks exist because the repo's .env.example ships the required keys BLANK and
# commented, and copying that template over a live .env.production produces a
# site that builds cleanly and is completely non-functional.
check_frontend_env() {
  local f="$BUILD_CTX/.env.production" bad=0 k v line

  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    k="${line%%=*}"; v="${line#*=}"
    case "$v" in
      *" "*) echo "    !! $k contains a space"; bad=1 ;;
      *REPLACE_ME*|*REPLACE-ME*) echo "    !! $k still holds a placeholder"; bad=1 ;;
    esac
    # Two values pasted together, e.g. "...googleusercontent.comcom.example.app"
    case "$v" in
      *.comcom.*|*.comhttps://*) echo "    !! $k looks like two values concatenated"; bad=1 ;;
    esac
  done < "$f"

  # Present AND non-empty. A key that is absent, blank, or commented out sends
  # axios to its localhost default and the deployed site talks to nothing.
  for k in NEXT_PUBLIC_API_URL NEXT_PUBLIC_SOCKET_URL; do
    grep -qE "^${k}=.+" "$f" || { echo "    !! $k is missing, blank or commented out"; bad=1; }
  done

  # Anything but "true" makes the client log full request and response bodies
  # to the browser console.
  grep -qE '^NEXT_PUBLIC_IS_PRODUCTION=true$' "$f" || {
    echo "    !! NEXT_PUBLIC_IS_PRODUCTION must be exactly 'true' on a live build"; bad=1; }

  if [ "$SVC" = website ]; then
    # app.config.ts derives the v2 base by replacing this exact suffix. A bare
    # host makes the regex miss, and every v2 call silently goes to v1.
    grep -qE '^NEXT_PUBLIC_API_URL=https?://[^ ]+/api/v1/?$' "$f" || {
      echo "    !! NEXT_PUBLIC_API_URL must END IN /api/v1 for the website"; bad=1; }
  else
    # getAdminApiBaseUrl() appends /admin/v1 itself; a path here double-prefixes.
    grep -qE '^NEXT_PUBLIC_API_URL=https?://[^/]+/?$' "$f" || {
      echo "    !! NEXT_PUBLIC_API_URL must be the BARE HOST for the admin panel"; bad=1; }
  fi

  [ "$bad" -eq 0 ] && echo "    env looks sane"
  return "$bad"
}

# --------------------------------------------------------------------------
# one full deploy cycle
# --------------------------------------------------------------------------
deploy_one() {
  resolve_target "$1" || die "unknown target: $1"

  local NEW_TAG="${IMAGE}:new"
  local PREV_TAG="${IMAGE}:prev"
  local LIVE_TAG="${IMAGE}:latest"
  local myip built had_prev code

  printf '\n'
  say "############################################################"
  say "# $SVC"
  say "############################################################"

  # -- host guard ----------------------------------------------------------
  # Building on the wrong box produces an image nothing will ever run.
  myip=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(76|187)\.' | head -1 || true)
  if [ -n "$myip" ] && [ "$myip" != "$EXPECT_HOST" ]; then
    die "$SVC is deployed on $EXPECT_HOST but this host is $myip"
  fi

  # -- preflight -----------------------------------------------------------
  step "[1/7] preflight"
  [ -d "$BUILD_CTX" ]   || die "build context not found: $BUILD_CTX"
  [ -d "$COMPOSE_DIR" ] || die "compose dir not found: $COMPOSE_DIR"
  [ -f "$COMPOSE_DIR/$ENV_FILE" ] || die "missing $COMPOSE_DIR/$ENV_FILE"
  if [ "$KIND" = frontend ]; then
    [ -f "$BUILD_CTX/.env.production" ] || die \
      "$BUILD_CTX/.env.production is missing — NEXT_PUBLIC_* are baked into the bundle at build time, so building without it silently ships localhost defaults"
    check_frontend_env || die \
      "refusing to build — fix the env problems above first. Nothing has changed yet."
  else
    [ -f "$DOCKERFILE" ] || die "missing $DOCKERFILE"
  fi
  disk_line

  # Written as explicit ifs, not `[ ... ] && low=1` — under `set -e` a trailing
  # && whose test is false makes the whole statement non-zero and aborts.
  local low=0
  if [ "$(free_gb)" -lt "$MIN_FREE_GB" ]; then low=1; fi
  if inodes_known && [ "$(free_inodes)" -lt "$MIN_FREE_INODES" ]; then low=1; fi

  if [ "$low" = 1 ]; then
    say "    below threshold (${MIN_FREE_GB}G / ${MIN_FREE_INODES} inodes) — reclaiming before build"
    reclaim
    disk_line
    [ "$(free_gb)" -ge "$MIN_FREE_GB" ] || die \
      "only $(free_gb)G free after reclaim, need ${MIN_FREE_GB}G. Nothing was built and nothing was changed. Investigate: docker system df -v ; sudo du -sh /var/lib/docker/*"
    if inodes_known; then
      [ "$(free_inodes)" -ge "$MIN_FREE_INODES" ] || die \
        "only $(free_inodes) inodes free after reclaim, need ${MIN_FREE_INODES}. Nothing was built and nothing was changed."
    fi
  fi

  # -- source --------------------------------------------------------------
  step "[2/7] source"
  if [ "$DO_PULL" = 1 ]; then
    git -C "$BUILD_CTX" fetch --quiet origin staging
    git -C "$BUILD_CTX" reset --hard --quiet origin/staging
    say "    pulled origin/staging"
  else
    say "    using the working tree as-is (pass --pull to fetch staging)"
  fi
  say "    at: $(git -C "$BUILD_CTX" log --oneline -1 2>/dev/null || echo 'not a git repo')"

  # -- build ---------------------------------------------------------------
  # Into :new, never straight into :latest. Until this succeeds the running
  # container and the image behind it are completely untouched.
  step "[3/7] building ${NEW_TAG} (several minutes)"

  built=1
  if [ "$KIND" = frontend ]; then
    docker build ${NO_CACHE} -t "$NEW_TAG" "$BUILD_CTX" || built=0
  else
    # Context MUST be the monorepo root — the Dockerfiles run a workspace install.
    docker build ${NO_CACHE} -f "$DOCKERFILE" -t "$NEW_TAG" "$BACKEND_DIR" || built=0
  fi

  if [ "$built" != 1 ]; then
    say ""
    say "    BUILD FAILED — nothing was swapped."
    say "    $CONTAINER is still running the previous image, untouched."
    # A failed build leaves partial layers behind. Clearing them here is what
    # stops nine consecutive failures from filling the disk.
    reclaim
    disk_line
    return 1
  fi
  say "    built OK"

  # -- promote -------------------------------------------------------------
  step "[4/7] promoting"
  had_prev=0
  if docker image inspect "$LIVE_TAG" >/dev/null 2>&1; then
    docker tag "$LIVE_TAG" "$PREV_TAG"
    had_prev=1
    say "    current image kept as $PREV_TAG"
  else
    say "    no existing $LIVE_TAG — first deploy, so there is no rollback point"
  fi
  docker tag "$NEW_TAG" "$LIVE_TAG"

  # -- swap ----------------------------------------------------------------
  step "[5/7] swapping container"
  ( cd "$COMPOSE_DIR" && docker compose --env-file "$ENV_FILE" up -d "$SVC" )

  # -- verify --------------------------------------------------------------
  step "[6/7] verifying /health"
  if wait_healthy 30; then
    say "    $CONTAINER is serving"
  else
    say ""
    say "    HEALTH CHECK FAILED — rolling back."
    say "    --- last 40 log lines from the failed container ---"
    docker logs --tail 40 "$CONTAINER" 2>&1 | sed 's/^/    /' || true
    say "    ---------------------------------------------------"

    if [ "$had_prev" = 1 ]; then
      docker tag "$PREV_TAG" "$LIVE_TAG"
      ( cd "$COMPOSE_DIR" && docker compose --env-file "$ENV_FILE" up -d "$SVC" )
      if wait_healthy 20; then
        say "    ROLLED BACK — $CONTAINER restored to the previous image and healthy."
      else
        say "    ROLLBACK ALSO UNHEALTHY — $CONTAINER needs manual attention NOW."
        say "    docker logs $CONTAINER --tail 100"
      fi
    else
      say "    No previous image to roll back to (first deploy). Container left as-is."
    fi
    # Keep :new around on failure — it is the image you want to debug.
    return 1
  fi

  # -- cleanup -------------------------------------------------------------
  # Re-tagging :prev above orphaned the image from two deploys ago. It is now
  # untagged, so a dangling prune reclaims it. Steady state per service is
  # exactly two images: :latest and :prev.
  step "[7/7] cleanup"
  docker image rm "$NEW_TAG" >/dev/null 2>&1 || true
  docker image prune -f >/dev/null 2>&1 || true
  say "    dropped the image from two deploys ago; :latest and :prev kept"

  # Build cache is capped by the daemon GC (see 10-docker-gc-setup.sh). This
  # is only a backstop for when that cap is not configured, or the box is tight.
  if [ "$(free_gb)" -lt "$((MIN_FREE_GB * 2))" ]; then
    say "    under $((MIN_FREE_GB * 2))G free — trimming unused build cache"
    docker builder prune -f >/dev/null 2>&1 || true
  fi
  disk_line

  # -- advisory ------------------------------------------------------------
  if [ -n "$PUBLIC_URL" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$PUBLIC_URL" 2>/dev/null || echo 000)
    case "$code" in
      2??) say "    $PUBLIC_URL -> $code" ;;
      *)   say "    NOTE: $PUBLIC_URL -> $code. The container is healthy, so look at HAProxy / Cloudflare, not the app." ;;
    esac
  fi

  say ""
  say "    $SVC deployed. Rollback if needed:"
  say "      docker tag $PREV_TAG $LIVE_TAG && cd $COMPOSE_DIR && docker compose --env-file $ENV_FILE up -d $SVC"
  return 0
}

# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
case "$TARGET" in
  "" | -h | --help)
    sed -n '2,17p' "$0" | sed 's/^#\{1,\} \{0,1\}//'
    exit 1
    ;;
esac

command -v docker >/dev/null || die "docker not found"
docker info >/dev/null 2>&1  || die "cannot talk to the docker daemon"

if [ "$TARGET" = "all-backend" ]; then
  [ -d "$BACKEND_DIR" ] || die "backend dir not found: $BACKEND_DIR"

  # Pull once for the whole monorepo, then run each service as its own full
  # cycle. One failure must not stop the other eight, and each service gets
  # its own disk preflight and its own cleanup — so nine builds in a row
  # cannot accumulate the way a plain build loop does.
  if [ "$DO_PULL" = 1 ]; then
    step "fetching origin/staging once for all services"
    git -C "$BACKEND_DIR" fetch --quiet origin staging
    git -C "$BACKEND_DIR" reset --hard --quiet origin/staging
    say "    at: $(git -C "$BACKEND_DIR" log --oneline -1)"
    DO_PULL=0
  fi

  OK=(); FAILED=()
  for s in "${BACKEND_SERVICES[@]}"; do
    if deploy_one "$s"; then OK+=("$s"); else FAILED+=("$s"); fi
  done

  printf '\n============================================================\n'
  say "deployed OK (${#OK[@]}): ${OK[*]:-none}"
  if [ "${#FAILED[@]}" -gt 0 ]; then
    say "FAILED   (${#FAILED[@]}): ${FAILED[*]}"
    say "Each failure either never swapped or was rolled back — no service is"
    say "left running a broken image."
    disk_line
    exit 1
  fi
  say "all services healthy"
  disk_line
  exit 0
fi

deploy_one "$TARGET"
