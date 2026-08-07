# AIMESS — Operations Guide

Everything here runs as **`rajvasu`**. Nothing in day-to-day operation needs
`sudo` — that was only required once, to install Docker and nginx.

```bash
ssh -p 22223 -i ~/.ssh/id_ed25519 rajvasu@76.13.216.164   # Dev 01
ssh -p 22223 -i ~/.ssh/id_ed25519 rajvasu@76.13.216.171   # Dev 02
ssh -p 22223 -i ~/.ssh/id_ed25519 rajvasu@187.77.130.157  # DB / Redis
```

> **Port is 22223, not 22. Auth is publickey only** — the password in
> `server_info.txt` will not log you in over SSH. It is the *sudo* password.

---

## 0. Which server do I touch?

| I changed… | Server | Rebuild? |
| --- | --- | --- |
| Any `apps/*` backend service | **Dev 02** | yes — that service's image |
| `packages/*` shared code | **Dev 02** | yes — **every** service depends on them |
| `aimess_website` | **Dev 01** | yes |
| `aimess_admin_panel` | **Dev 02** | yes |
| A `NEXT_PUBLIC_*` value | Dev 01 or 02 | **yes — baked in at build time** |
| A backend env value | Dev 02 | no — just recreate the container |
| An nginx vhost | that server | no — install + reload |
| A Prisma schema | Dev 02 (build) + Dev 01 (migrate) | yes, and run the migration |

---

## 1. Standard release — backend service change

Say you changed `chat-service` and merged to `staging`.

```bash
ssh -p 22223 rajvasu@76.13.216.171
cd /opt/aimess/aimess_backend

# 1. Pull. Use reset, not pull: the working tree must match the branch exactly.
git fetch origin staging && git reset --hard origin/staging
git log --oneline -1                       # confirm you got what you expect

# 2. Rebuild ONLY that service. Context must be the repo root.
docker build -f apps/chat-service/Dockerfile -t aimess-chat-service:latest .

# 3. Recreate just that container. Others keep running.
cd deploy/dev02
docker compose --env-file .env.dev02 up -d chat-service

# 4. Verify
docker compose --env-file .env.dev02 ps
docker logs aimess-chat-service --tail 40
```

**Rebuild all 9 backend services** (needed when `packages/*` changed):

```bash
cd /opt/aimess/aimess_backend
git fetch origin staging && git reset --hard origin/staging
bash deploy/scripts/06-build-images.sh dev02 /opt/aimess/aimess_backend
cd deploy/dev02 && docker compose --env-file .env.dev02 up -d
```

That takes roughly 15–25 minutes for all nine.

---

## 2. Release — website (Dev 01)

```bash
ssh -p 22223 rajvasu@76.13.216.164
cd /opt/aimess/aimess_website
git fetch origin staging && git reset --hard origin/staging

# .env.production MUST exist and be correct BEFORE the build —
# NEXT_PUBLIC_* is compiled into the browser bundle, not read at runtime.
docker build -t aimess-website:latest .

cd /opt/aimess/aimess_backend/deploy/dev01
docker compose --env-file .env.dev01 up -d website
docker logs aimess-website --tail 30
```

## 3. Release — admin panel (Dev 02)

```bash
ssh -p 22223 rajvasu@76.13.216.171
cd /opt/aimess/aimess_admin_panel
git fetch origin staging && git reset --hard origin/staging
docker build -t aimess-admin-panel:latest .

cd /opt/aimess/aimess_backend/deploy/dev02
docker compose --env-file .env.dev02 up -d admin-panel
```

> **Changing any `NEXT_PUBLIC_*` value requires a rebuild.** Editing it in
> compose or the env file does nothing — the old value is already inside the
> JavaScript. This catches people out constantly.

---

## 4. Logs

```bash
# follow one service
docker logs -f aimess-chat-service

# last 100 lines
docker logs --tail 100 aimess-api-gateway

# only the last 10 minutes
docker logs --since 10m aimess-auth-service

# errors only (services log JSON)
docker logs --since 1h aimess-user-service 2>&1 | grep '"level":"error"'

# everything on this host, interleaved
cd /opt/aimess/aimess_backend/deploy/dev02
docker compose --env-file .env.dev02 logs -f

# error count per service — quick health sweep
for c in aimess-api-gateway aimess-auth-service aimess-user-service \
         aimess-community-service aimess-chat-service aimess-media-service \
         aimess-stream-service aimess-backoffice-service aimess-notifications-service; do
  echo "$c: $(docker logs $c --since 10m 2>&1 | grep -c '"level":"error"')"
done
```

nginx:

```bash
sudo tail -f /var/log/nginx/api.ai5dev.tech.error.log
sudo tail -f /var/log/nginx/api.ai5dev.tech.access.log
```

Logs are capped at 20 MB × 5 files per container, so they cannot fill the disk.

---

## 5. Restart / stop / start

```bash
cd /opt/aimess/aimess_backend/deploy/dev02      # or deploy/dev01

docker compose --env-file .env.dev02 restart chat-service   # restart one
docker compose --env-file .env.dev02 restart                # restart all
docker compose --env-file .env.dev02 up -d                  # apply env/compose changes
docker compose --env-file .env.dev02 down                   # stop all (volumes kept)
docker compose --env-file .env.dev02 up -d                  # bring back
```

`restart` reuses the existing container — it does **not** pick up changes to
`.env.dev02` or `compose.yml`. Use `up -d` for that; compose recreates only the
containers whose config actually changed.

**Order matters after a full outage:** start Dev 01 first, then Dev 02. Dev 02's
services connect to Dev 01's datastores at boot.

---

## 6. Changing an environment value

```bash
ssh -p 22223 rajvasu@76.13.216.171
cd /opt/aimess/aimess_backend/deploy/dev02
cp .env.dev02 .env.dev02.bak-$(date +%F-%H%M)     # always
nano .env.dev02
docker compose --env-file .env.dev02 up -d        # recreates changed containers
```

Shared secrets live in `/opt/aimess/shared-secrets.env` (mode 600) on **both**
Dev 01 and Dev 02, and the two copies must stay identical:

```bash
sha256sum /opt/aimess/shared-secrets.env    # run on both; digests must match
```

Values that must agree across hosts: `POSTGRES_*`, `MONGO_ROOT_*`,
`RABBITMQ_*`, `MINIO_*`, `REDIS_PASSWORD`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`. `GRPC_SERVICE_TOKEN` and `JWT_ACCESS_SECRET` must be
identical across every service.

---

## 7. Database migrations

Production images ship without the Prisma CLI, so migrations run in a throwaway
container that **joins the compose network** — do not use the LAN IP here, the
hairpin route is unreliable from inside a container.

Run on **Dev 01**:

```bash
cd /opt/aimess/aimess_backend/deploy/dev01
set -a; . ./.env.dev01; set +a
PG="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432"
MG="mongodb://${MONGO_ROOT_USERNAME}:${MONGO_ROOT_PASSWORD}@mongodb:27017"
Q="authSource=admin&directConnection=true"

docker run --rm --network aimess-dev01_aimess \
  -v /opt/aimess/aimess_backend:/repo -w /repo \
  -e CI=true -e HUSKY=0 \
  -e AUTH_DATABASE_URL="${PG}/aimess_auth" \
  -e USER_DATABASE_URL="${PG}/aimess_users" \
  -e ADMIN_DATABASE_URL="${PG}/admin_db" \
  node:22-bookworm-slim bash -c \
  'corepack enable && corepack prepare pnpm@11.0.8 --activate && \
   pnpm install --frozen-lockfile && pnpm db:migrate:deploy'
```

MongoDB uses `db push` (index sync), one database per service — swap
`MONGO_DATABASE_URL` and the script each time:

| Service | Database | Command |
| --- | --- | --- |
| community | `community_db` | `pnpm db:push:community` (uses `COMMUNITY_DATABASE_URL`) |
| stream | `stream_db` | `pnpm db:push:stream` (uses `STREAM_DATABASE_URL`) |
| chat | `aimess_chat` | `pnpm db:push:chat` (uses `MONGO_DATABASE_URL`) |
| notifications | `aimess_notifications` | `pnpm db:push:notifications` (uses `MONGO_DATABASE_URL`) |

Run migrations **before** starting the new service image if a release adds
columns the code requires.

---

## 8. Health checks

```bash
# from anywhere
curl -fsS https://api.ai5dev.tech/health
curl -fsS https://backoffice.ai5dev.tech/health
curl -fsS 'https://api.ai5dev.tech/socket.io/?EIO=4&transport=polling'   # expect a sid
curl -fsSI https://website.ai5dev.tech | head -1
curl -fsSI https://admin.ai5dev.tech  | head -1

# datastores — from Dev 02
for p in 5432 27017 5672 9000; do nc -vz -w3 76.13.216.164 $p; done
nc -vz -w3 187.77.130.157 52023

# these MUST time out from anywhere else — if they connect, the firewall broke
nc -vz -w3 76.13.216.164 5432
```

Mongo replica set (on Dev 01) — `myState` must be `1`:

```bash
cd /opt/aimess/aimess_backend/deploy/dev01 && set -a; . ./.env.dev01; set +a
docker exec aimess-mongodb mongosh --quiet -u "$MONGO_ROOT_USERNAME" \
  -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin \
  --eval 'rs.status().myState'
```

---

## 9. TLS certificates

Auto-renewed by certbot's systemd timer; a deploy hook reloads nginx.

```bash
sudo certbot certificates          # expiry dates
sudo certbot renew --dry-run       # verify renewal still works
sudo systemctl list-timers 'certbot*'
```

Adding a domain: edit/add a vhost in `deploy/nginx/sites/`, then

```bash
sudo bash deploy/scripts/05-issue-certs.sh dev02 you@example.com
```

nginx changes:

```bash
sudo install -m 0644 deploy/nginx/sites/dev02-api.conf /etc/nginx/sites-available/dev02-api.conf
sudo nginx -t && sudo systemctl reload nginx     # ALWAYS test before reloading
```

---

## 10. Firewall

Rules live in two places and both matter:

```bash
sudo ufw status verbose                    # host services
sudo iptables -L DOCKER-USER -n -v         # container ports
sudo systemctl status aimess-docker-firewall    # reapplies DOCKER-USER on boot
```

**Docker bypasses ufw.** If you publish a new container port, ufw will not
protect it — the DOCKER-USER rules do. On Dev 02 the rule drops everything
inbound from `eth0`, so new ports are closed by default; on Dev 01 only
`76.13.216.171` is allowed through to the datastores.

---

## 11. Troubleshooting

| Symptom | Likely cause | Check |
| --- | --- | --- |
| Container restart-loops | env validation or a missing dependency | `docker logs <name> --tail 50` |
| `502` from nginx | container down or not listening | `docker ps` then `curl 127.0.0.1:<port>` on the host |
| `522` from Cloudflare | nginx itself down, or :443 not listening | `sudo nginx -t; ss -tlnp \| grep 443` |
| Frontend calls the wrong API | `NEXT_PUBLIC_*` baked into an old image | rebuild the frontend image |
| `NOAUTH` from Redis | `REDIS_PASSWORD` missing/wrong | check `.env.dev02` |
| Prisma "Transactions are not supported" | replica set lost its primary | `rs.status().myState` must be 1 |
| Prisma "could not locate the Query Engine" | builder/runner libc or openssl mismatch | both stages must be `bookworm-slim` with `openssl` installed |
| `ENOENT … .proto` | proto files missing from the image | Dockerfile must copy them to `/packages/grpc-contracts/proto` |
| Socket.IO 404 | wrong path | it is `/socket.io/` on api-gateway, **not** `/z-socket/` |
| Upload 413 at ~100 MB | `minio.ai5dev.tech` is Cloudflare-proxied | grey-cloud that record |
| Call connects, no audio/video | `notification.ai5dev.tech` is proxied | grey-cloud it — UDP cannot proxy |

Full reset of one service:

```bash
cd /opt/aimess/aimess_backend/deploy/dev02
docker compose --env-file .env.dev02 rm -sf chat-service
docker compose --env-file .env.dev02 up -d chat-service
```

---

## 12. Rollback

```bash
cd /opt/aimess/aimess_backend
git reset --hard <last-good-sha>
docker build -f apps/chat-service/Dockerfile -t aimess-chat-service:latest .
cd deploy/dev02 && docker compose --env-file .env.dev02 up -d chat-service
```

Tag before risky releases so rollback is one command:

```bash
docker tag aimess-chat-service:latest aimess-chat-service:pre-$(date +%F)
```

Images are built on the servers — there is no registry — so a rollback means a
rebuild unless you tagged first.

---

## 13. Backups — not yet configured

Nothing is scheduled. Worth doing before real users:

```bash
# PostgreSQL (all databases)
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" aimess-postgres \
  pg_dumpall -U "$POSTGRES_USER" > /opt/aimess/backups/pg-$(date +%F).sql

# MongoDB
docker exec aimess-mongodb mongodump --username "$MONGO_ROOT_USERNAME" \
  --password "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin \
  --archive=/tmp/mongo.archive && docker cp aimess-mongodb:/tmp/mongo.archive .

# MinIO — copy the volume, or use `mc mirror` to another target
```

Redis has AOF enabled (`everysec`), so at most ~1 second of writes is at risk
there. PostgreSQL, MongoDB and MinIO have **no** backup at all right now.
