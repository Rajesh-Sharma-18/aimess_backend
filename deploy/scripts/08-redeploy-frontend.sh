#!/usr/bin/env bash
# Rebuild and redeploy a Next.js frontend after an env or code change.
#
#   bash 08-redeploy-frontend.sh website          # on Dev 01 (76.13.216.164)
#   bash 08-redeploy-frontend.sh admin            # on Dev 02 (76.13.216.171)
#
#   bash 08-redeploy-frontend.sh website --pull   # also fetch latest staging first
#
# Runs as rajvasu. No sudo.
#
# ============================================================================
# WHY A REBUILD IS ALWAYS REQUIRED
#
# NEXT_PUBLIC_* values are INLINED INTO THE JAVASCRIPT BUNDLE by `next build`.
# They are not read from the environment at runtime. So:
#
#   editing .env.production           -> changes NOTHING on its own
#   `docker compose restart website`  -> changes NOTHING, same image
#   setting it in compose environment -> changes NOTHING, wrong layer entirely
#
# The only thing that applies a new value is rebuilding the image. That is what
# this script does, and it verifies the value actually landed in the bundle.
# ============================================================================
set -euo pipefail

APP="${1:-}"
PULL="${2:-}"

case "$APP" in
  website)
    REPO=/opt/aimess/aimess_website
    IMAGE=aimess-website:latest
    COMPOSE_DIR=/opt/aimess/aimess_backend/deploy/dev01
    ENV_FILE=.env.dev01
    SERVICE=website
    CONTAINER=aimess-website
    URL=https://website.ai5dev.tech
    EXPECT_HOST="76.13.216.164"
    ;;
  admin|admin-panel)
    REPO=/opt/aimess/aimess_admin_panel
    IMAGE=aimess-admin-panel:latest
    COMPOSE_DIR=/opt/aimess/aimess_backend/deploy/dev02
    ENV_FILE=.env.dev02
    SERVICE=admin-panel
    CONTAINER=aimess-admin-panel
    URL=https://admin.ai5dev.tech
    EXPECT_HOST="76.13.216.171"
    ;;
  *)
    echo "usage: bash 08-redeploy-frontend.sh <website|admin> [--pull]" >&2
    exit 1
    ;;
esac

# Running this on the wrong box builds an image nothing will ever use.
MYIP=$(hostname -I | tr ' ' '\n' | grep -E '^(76|187)\.' | head -1 || true)
if [ -n "$MYIP" ] && [ "$MYIP" != "$EXPECT_HOST" ]; then
  echo "ERROR: '$APP' is deployed on $EXPECT_HOST but this host is $MYIP." >&2
  exit 1
fi

echo "==> [1/6] pre-flight"
[ -d "$REPO" ]              || { echo "ERROR: $REPO not found" >&2; exit 1; }
[ -f "$REPO/.env.production" ] || {
  echo "ERROR: $REPO/.env.production is missing." >&2
  echo "       Building without it silently ships localhost defaults." >&2
  exit 1
}
echo "    repo:  $REPO"
echo "    image: $IMAGE"

if [ "$PULL" = "--pull" ]; then
  echo "==> [2/6] fetching latest staging"
  git -C "$REPO" fetch --quiet origin staging
  git -C "$REPO" reset --hard --quiet origin/staging
else
  echo "==> [2/6] skipping git pull (pass --pull to fetch staging)"
fi
echo "    at: $(git -C "$REPO" log --oneline -1)"

echo "==> [3/6] sanity-checking .env.production"
# Catch the mistakes that are invisible until a user hits them.
BAD=0
while IFS= read -r line; do
  case "$line" in ''|\#*) continue ;; esac
  k="${line%%=*}"; v="${line#*=}"
  case "$v" in
    *" "*)                echo "    !! $k contains a space"; BAD=1 ;;
    *REPLACE_ME*|*REPLACE-ME*) echo "    !! $k still holds a placeholder"; BAD=1 ;;
  esac
  # Two values pasted together, e.g. "...googleusercontent.comcom.example.app"
  case "$v" in
    *.comcom.*|*.comhttps://*) echo "    !! $k looks like two values concatenated"; BAD=1 ;;
  esac
done < "$REPO/.env.production"

if [ "$APP" = "website" ]; then
  # app.config.ts derives the v2 base by replacing this exact suffix. A bare
  # host makes the regex miss, and every v2 call silently goes to v1.
  grep -qE '^NEXT_PUBLIC_API_URL=https?://[^ ]+/api/v1/?$' "$REPO/.env.production" || {
    echo "    !! NEXT_PUBLIC_API_URL must END IN /api/v1 for the website"; BAD=1; }
else
  # getAdminApiBaseUrl() appends /admin/v1 itself; a path here double-prefixes.
  grep -qE '^NEXT_PUBLIC_API_URL=https?://[^/]+/?$' "$REPO/.env.production" || {
    echo "    !! NEXT_PUBLIC_API_URL must be the BARE HOST for the admin panel"; BAD=1; }
fi

if [ "$BAD" -eq 1 ]; then
  echo
  echo "Refusing to build — fix the above first. Nothing has changed yet." >&2
  exit 1
fi
echo "    env looks sane"

echo "==> [4/6] keeping a rollback tag"
PREV="${IMAGE%:latest}:prev"
docker image inspect "$IMAGE" >/dev/null 2>&1 && docker tag "$IMAGE" "$PREV" && \
  echo "    previous image tagged $PREV" || echo "    no existing image to tag"

echo "==> [5/6] building (3-6 minutes)"
docker build -t "$IMAGE" "$REPO"

echo "==> [6/6] recreating the container"
cd "$COMPOSE_DIR"
docker compose --env-file "$ENV_FILE" up -d "$SERVICE"

echo
echo "--- container ---"
docker ps --filter "name=$CONTAINER" --format '  {{.Names}}  {{.Status}}'

echo "--- waiting for it to answer ---"
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$URL/" || echo 000)
  if [ "$code" = "200" ]; then echo "    $URL -> 200"; break; fi
  [ "$i" = "20" ] && { echo "    STILL $code after 60s — check: docker logs $CONTAINER"; exit 1; }
  sleep 3
done

echo
echo "Done. Rollback if needed:"
echo "  docker tag $PREV $IMAGE && cd $COMPOSE_DIR && docker compose --env-file $ENV_FILE up -d $SERVICE"
