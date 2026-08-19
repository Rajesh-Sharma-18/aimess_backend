# AIMESS production deployment

Deploys the three repos (`aimess_backend`, `aimess_admin_panel`, `aimess_website`)
across the two Dev servers, reusing the existing Redis and leaving the stream
server untouched.

---

## 1. Verified starting state

Audited **2026-08-06** by SSH. Several facts differ from `server_info.txt` — the
corrections are load-bearing, so read this table before anything else.

| `server_info.txt` says                    | Actual                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| SSH port 22                               | **22223 on all four servers**                                                               |
| Password auth (`rajvasu@tech5`)           | **Disabled everywhere — publickey only.** The working key is `~/.ssh/id_ed25519`            |
| Sudo password `rajvasu@tech5`             | **Rejected on all three servers.** `rajvasu` is in the `sudo` group but that password fails |
| DB server runs MongoDB, PostgreSQL, Redis | **Only Redis.** Neither MongoDB nor PostgreSQL is installed                                 |

| Host      | IP               | Specs                                        | State at audit                                                               |
| --------- | ---------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| Dev 01    | `76.13.216.164`  | 4 vCPU / 15 GB / 191 GB free, Ubuntu 24.04.4 | **Bare** — only sshd                                                         |
| Dev 02    | `76.13.216.171`  | 4 vCPU / 15 GB / 191 GB free, Ubuntu 24.04.4 | **Bare** — only sshd                                                         |
| DB / SIEM | `187.77.130.157` | 4 vCPU / 15 GB / 176 GB free, Ubuntu 24.04.4 | **Wazuh** (manager + indexer + dashboard on 443) **+ Redis 7.0.15** on 52023 |
| Stream    | `72.62.69.126`   | not inspected                                | `ai5stream.tech` → direct A record. **Left alone by design**                 |

All three hosts are in one datacenter — **0.42 ms RTT** between them — but there
is **no private network**. Every interface is public, which is why the firewall
scripts in `scripts/` are not optional.

---

## 2. Topology

```
                    Cloudflare
                        │
        ┌───────────────┴────────────────┐
        ▼                                ▼
  Dev 01  76.13.216.164            Dev 02  76.13.216.171
  ─────────────────────            ─────────────────────
  HAProxy :80/:443                 HAProxy :80/:443
   ai5dev.tech              api.ai5dev.tech         → api-gateway  :3000
   minio.ai5dev.tech                  └ /z-socket/          → chat-service :3004
   minio-console.ai5dev.tech        admin.ai5dev.tech       → admin-panel  :3011
   rabbitmq.ai5dev.tech             backoffice.ai5dev.tech  → backoffice   :3010
   livekit.ai5dev.tech
                                   Internal (compose network, no host port):
  PostgreSQL   :5432   ◄────────┐    auth :3001/:4001   user :3002/:4002
  MongoDB rs0  :27017  ◄────────┤    community :3003/:4003  chat :3004/:4004
  RabbitMQ     :5672   ◄────────┤    notifications :3006/:4006
  MinIO        :9000   ◄────────┘    media :3009/:4009  backoffice :3010/:4010
  LiveKit      :7880/:7881/:50000-50100u
  website      :3000 (loopback)     admin-panel :3011 (loopback)
        │                                │
        └────────────┬───────────────────┘
                     ▼
        DB / SIEM  187.77.130.157
        Redis :52023  (reused as-is)
        Wazuh :443/:1514/:1515/:55000  (untouched)

        Stream  72.62.69.126  —  ai5stream.tech
        SRS + stream-service :3007 / gRPC :4007   (UNTOUCHED)
```

**Why all app services sit on Dev 02:** every gRPC hop stays on the compose
bridge network. The alternative split in `server_info.txt` (auth/community/
notification on Dev 01, gateway on Dev 02) would push authenticated gRPC across
public interfaces on every request.

---

## 3. Domain allocation

| Subdomain                                     | Points at | Cloudflare     | Notes                                       |
| --------------------------------------------- | --------- | -------------- | ------------------------------------------- |
| `api.ai5dev.tech`                             | Dev 02    | proxied        | REST **and** Socket.IO (`/z-socket/`)       |
| `admin.ai5dev.tech`                           | Dev 02    | proxied        | Admin panel                                 |
| `backoffice.ai5dev.tech`                      | Dev 02    | proxied        | Admin API                                   |
| `ai5dev.tech`                                 | Dev 01    | proxied        | Consumer website                            |
| `minio.ai5dev.tech`                           | Dev 01    | **grey-cloud** | See the 100 MB warning below                |
| `rabbitmq.ai5dev.tech`                        | Dev 01    | proxied        | Management UI — IP-restrict it              |
| `media.ai5stream.tech`                        | Dev 01    | **grey-cloud** | **Reused for LiveKit signaling**            |
| `auth.ai5dev.tech`                            | Dev 01    | proxied        | **Reused for the MinIO console** (optional) |
| `community.ai5dev.tech` `backend.ai5dev.tech` | —         | —              | Still spare                                 |

**No new domains are needed.** `notification.` and `auth.` were provisioned for
notification-service and auth-service, neither of which should be public —
both sit behind `api.ai5dev.tech`, and a direct public route to auth-service
would bypass the gateway's sensitive-auth rate limiting. Reusing the two names
costs nothing.

The names no longer describe what they serve. That is recorded in
`deploy/haproxy/dev01.cfg` (and the superseded `deploy/nginx/sites/*`) so the
next person is not misled.

**Only DNS change required:** point `media.ai5stream.tech` at
`76.13.216.164` as **grey-cloud (DNS-only)**.

### Two Cloudflare traps

1. **LiveKit must be grey-cloud.** Media runs over UDP 50000-50100 and TCP 7881
   directly to Dev 01. Cloudflare's proxy carries neither. Orange-cloud makes
   signaling succeed and every call connect with **no audio or video** — the app
   reports a healthy room join, so this looks like an application bug.

2. **MinIO vs. the 100 MB cap.** `CHAT_VIDEO_MAX_BYTES` is `104857600` — exactly
   Cloudflare's free-plan request-body limit. Proxied, video uploads fail with a
   413 generated by Cloudflare that never reaches MinIO and so appears in no
   application log. Grey-cloud `minio.ai5dev.tech`, or lower the `*_MAX_BYTES`
   values in `.env.dev02`.

---

## 4. What was added to the repos

### New Dockerfiles (4 backend services had none)

`apps/backoffice-service`, `apps/community-service`, `apps/media-service`,
`apps/notifications-service` — matching the existing multi-stage, non-root
pattern. The three Mongo services copy `src/generated/prisma` into `dist/`
(Prisma 6's `prisma-client-js` emits `.js`, which `tsc` does not compile);
backoffice uses Prisma 7's `prisma-client`, whose TypeScript output `tsc` picks
up on its own. All four also copy `dist/` explicitly, because `dist` is
gitignored and `pnpm deploy` therefore omits it.

### New Dockerfiles for both frontends (neither had Docker at all)

`aimess_admin_panel/Dockerfile`, `aimess_website/Dockerfile`, plus
`.dockerignore` for each. Both repos gained `output: "standalone"` in
`next.config.ts` — without it the runtime stage needs the full `node_modules`.

> **`NEXT_PUBLIC_*` is baked in at build time.** Those values are inlined into
> the browser bundle by `next build`. Setting them in compose does nothing.
> Each frontend repo needs a `.env.production` **before** its image is built,
> and changing any value means rebuilding the image.

### Redis password support — required code change

The shared client (`packages/redis/src/client.ts`) accepted only `host` and
`port`. The existing Redis requires a password, so **every service would have
failed with `NOAUTH`**. Added optional `username`/`password` there, threaded
`REDIS_PASSWORD` through all eight services' env schemas and connection sites,
and gave Bull (`media-service`) a `BULL_REDIS_PASSWORD` that falls back to
`REDIS_PASSWORD`. `api-gateway` was already fine — it takes a `REDIS_URL`, which
can carry the password inline.

Verified with `pnpm exec turbo run typecheck` — **20/20 tasks pass**.

### Other repo changes

- `package.json` → `docker:build:apps` now covers all nine services (was four).
- `apps/*/.env.example` → documented `REDIS_PASSWORD` / `BULL_REDIS_PASSWORD`.

---

## 5. Known issues in the existing env files

Handled in `deploy/*/.env.*.example` and the compose files, but worth knowing:

| Issue                                                                                   | Resolution                                                                                                          |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `AUTH_GRPC_URL=0.0.0.0:4001` and similar throughout                                     | `0.0.0.0` is a **bind** address, not a valid dial target. Compose sets these to service names (`auth-service:4001`) |
| Mongo port disagreement — `27018` (community, stream) vs `27017` (media, notifications) | `27017` everywhere                                                                                                  |
| RabbitMQ port disagreement — `5673` (community, stream) vs `5672` (chat)                | `5672` everywhere                                                                                                   |
| `GRPC_SERVICE_TOKEN=dev-grpc-service-token-change-me`                                   | Must be regenerated. With `NODE_ENV=production` services **refuse to start** if unset — deliberate                  |
| `MINIO_ENDPOINT=http://10.0.127.227:9000`, `SRS_CANDIDATE=10.0.127.227`                 | Dev LAN addresses, replaced                                                                                         |
| `MONGO_DATABASE` empty in `chat-service/.env.example`                                   | It is the **authSource**; empty produces `authSource=` and auth fails. Set to `admin`                               |
| `LINK_HOSTS` / `WEB_APP_URL` / `INVITE_LINK_BASE_URL`                                   | All default to `ai5dev.tech` now. `aimess.me` does **not** resolve — never point them at it                         |
| `OTP_DEV_FIXED_CODE=123456`                                                             | ⚠ Must be **empty** in production. Any value is accepted as a valid OTP for every account                           |

---

## 6. Deployment

Everything below needs `sudo`, which you are running yourself. Each script
prints what it changed and how to verify it.

```bash
ssh -p 22223 -i ~/.ssh/id_ed25519 rajvasu@<host>
```

### Step 0 — get the code onto both servers

```bash
sudo mkdir -p /opt/aimess && sudo chown rajvasu:rajvasu /opt/aimess
cd /opt/aimess
git clone <backend-repo>  aimess_backend
git clone <website-repo>  aimess_website        # Dev 01 only
git clone <admin-repo>    aimess_admin_panel    # Dev 02 only
```

### Step 1 — secure Redis first

Redis is currently reachable from the whole internet on 52023 with only a
password. Close that before anything else starts using it.

```bash
# On 187.77.130.157
sudo bash /opt/aimess/aimess_backend/deploy/scripts/03-firewall-dbserver.sh
sudo bash /opt/aimess/aimess_backend/deploy/scripts/04-redis-enable-aof.sh
```

`04` enables AOF. Without it, an unclean shutdown loses up to 60 s of writes —
queued media scans, sessions, pending OTPs.

### Step 2 — bootstrap both hosts

```bash
# Dev 01
sudo bash /opt/aimess/aimess_backend/deploy/scripts/00-bootstrap-host.sh dev01
sudo bash /opt/aimess/aimess_backend/deploy/scripts/01-firewall-dev01.sh

# Dev 02
sudo bash /opt/aimess/aimess_backend/deploy/scripts/00-bootstrap-host.sh dev02
sudo bash /opt/aimess/aimess_backend/deploy/scripts/02-firewall-dev02.sh
```

Log out and back in afterwards so the `docker` group applies.

> The firewall scripts write rules into the **DOCKER-USER** iptables chain, not
> just ufw. Docker inserts its rules ahead of ufw's, so a published container
> port is reachable from the internet even when `ufw status` shows it denied.
> Skipping these leaves PostgreSQL and MongoDB publicly exposed.

### Step 3 — fill in secrets

```bash
cd /opt/aimess/aimess_backend/deploy/dev01     # and dev02
cp .env.dev01.example .env.dev01 && chmod 600 .env.dev01
```

Generate every secret with `openssl rand -base64 36`. These **must match across
both files**: `POSTGRES_*`, `MONGO_ROOT_*`, `RABBITMQ_*`, `MINIO_*`,
`REDIS_PASSWORD`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.

`GRPC_SERVICE_TOKEN` and `JWT_ACCESS_SECRET` must also match whatever the
**stream server** already uses, or gRPC between it and Dev 02 fails closed.

### Step 4 — certificates

```bash
# Dev 01
sudo bash deploy/scripts/05-issue-certs.sh dev01 you@example.com
# Dev 02
sudo bash deploy/scripts/05-issue-certs.sh dev02 you@example.com
```

Point the Cloudflare records at the right origin first, and set
`livekit.` / `minio.` to grey-cloud.

### Step 5 — build images

```bash
# Dev 01 — website only
bash deploy/scripts/06-build-images.sh dev01 /opt/aimess/aimess_backend /opt/aimess/aimess_website

# Dev 02 — eight services + admin panel
bash deploy/scripts/06-build-images.sh dev02 /opt/aimess/aimess_backend /opt/aimess/aimess_admin_panel
```

Create each frontend's `.env.production` **before** this — the script refuses to
build without one.

### Step 6 — start Dev 01, then Dev 02

Order matters: Dev 02's services connect to Dev 01's datastores at startup.

```bash
# Dev 01
cd /opt/aimess/aimess_backend/deploy/livekit
set -a && . ../dev01/.env.dev01 && set +a
envsubst < config.yaml.template > config.yaml

cd ../dev01
docker compose --env-file .env.dev01 up -d
docker compose --env-file .env.dev01 ps
docker logs aimess-mongo-init      # must report the replica set ready
docker logs aimess-minio-init      # must report four buckets
```

Then apply database migrations from Dev 02 (production images ship without the
Prisma CLI, so run these from the repo checkout):

```bash
cd /opt/aimess/aimess_backend
corepack enable && pnpm install --frozen-lockfile
AUTH_DATABASE_URL=... USER_DATABASE_URL=... ADMIN_DATABASE_URL=... pnpm db:migrate:deploy
COMMUNITY_DATABASE_URL=... pnpm db:push:community
MONGO_DATABASE_URL=... pnpm db:push:chat
MONGO_DATABASE_URL=... pnpm db:push:notifications
```

Finally:

```bash
cd /opt/aimess/aimess_backend/deploy/dev02
docker compose --env-file .env.dev02 up -d
docker compose --env-file .env.dev02 ps
```

### Step 7 — verify

```bash
curl -fsS https://api.ai5dev.tech/health
curl -fsSI https://ai5dev.tech | head -1
curl -fsSI https://admin.ai5dev.tech | head -1
curl -fsSI https://backoffice.ai5dev.tech | head -1

# Socket.IO handshake (expect HTTP 200 and a JSON payload)
curl -fsS 'https://api.ai5dev.tech/z-socket/?EIO=4&transport=polling'

# Datastores must NOT answer from outside — all four should time out
for p in 5432 27017 5672 9000; do nc -vz -w3 76.13.216.164 $p; done
nc -vz -w3 187.77.130.157 52023

# gRPC to the stream server, from Dev 02
nc -vz -w3 72.62.69.126 4007
```

---

## 6b. The stream server and the other environment (verified 2026-08-06)

A read-only inspection of `72.62.69.126` changed two assumptions:

**stream-service is not there.** That host runs **only SRS** — RTMP on 1935,
internal 1936/1937/1984/1985/8080, an ABR supervisor script and live ffmpeg
transcodes — behind nginx for `ai5stream.tech`. Nothing listens on 3007 or 4007.
stream-service therefore runs on **Dev 02** with the other services.

**A second, live environment already exists.** SRS's `rtmp2rtc.conf` posts its
hooks to:

```
https://aimess.api.vasundharasolutions.com/internal/srs/hooks?secret=3ffbbfb2c073a9b9f8d52c2235f1341b
```

`aimess.api.vasundharasolutions.com` and `aimess.vasundharasolutions.com` both
resolve to `13.203.130.146`, and `/health` returns
`{"success":true,"message":"API Gateway Running"}`. That is a running AIMESS
stack on a different host and domain — the one whose stream-service owns those
hooks today.

Consequences:

- The `GRPC_SERVICE_TOKEN` / `JWT_ACCESS_SECRET` in use live on `13.203.130.146`,
  not on the stream server. This deployment should generate **fresh** secrets
  rather than share them — two environments sharing a JWT signing key means a
  token minted in one is valid in the other.
- **Livestreams will not go LIVE here until SRS hooks are addressed.** SRS
  notifies exactly one backend, and it is currently the other one. Until that is
  resolved, a stream started through this environment stays `PENDING` forever.
  Resolving it means editing SRS config on the stream server.

Reference values read from the live SRS/nginx config, already in
`.env.dev02.example`:

| Setting                 | Value                                           |
| ----------------------- | ----------------------------------------------- |
| WHIP ingest             | `https://ai5stream.tech/ingest`                 |
| WebRTC / control API    | `https://ai5stream.tech/rtc` , `/api` → `:1985` |
| HLS + HTTP-FLV playback | `https://ai5stream.tech` → `:8080`              |
| RTMP                    | `rtmp://ai5stream.tech:1935`                    |
| `SRS_HOOK_SECRET`       | `3ffbbfb2c073a9b9f8d52c2235f1341b`              |

Minor unrelated bug spotted: the port-80 block of
`/etc/nginx/sites-enabled/ai5stream.tech` has `server_name ai5stream.tech
www.kai5stream.tech` — note the stray `k`, so `www.ai5stream.tech` does not
redirect to HTTPS.

---

## 7. Open items

1. **Sudo credentials** — the password in `server_info.txt` does not work. Every
   step above needs working `sudo`.
2. **Live `.env.dev02` deep-link block is still stale.** The git template
   (`deploy/dev02/.env.dev02.example`) is correct, but the live file on the
   server is a separate copy. Set by hand, then restart chat-service **and**
   community-service (they share one `env_file`, so one edit fixes both):

   ```
   ANDROID_PACKAGE_NAME=com.aifivetech.aimess.app
   ANDROID_SHA256_CERT_FINGERPRINTS=<Play cert>,<upload cert>   # see the template
   ANDROID_STORE_APP_ID=com.aifivetech.aimess.app
   INVITE_LINK_BASE_URL=https://ai5dev.tech
   ```

   Confirm afterwards that a freshly created group invite comes back as
   `https://ai5dev.tech/g/<token>` and not the dead `aimess.me` domain.
   Cloudflare must also NOT challenge `https://ai5dev.tech/.well-known/*`, or
   Android App Link verification fails with no visible error. See
   `docs/deep-linking/IMPLEMENTATION.md`.

3. **Two DNS records to create** — `livekit.ai5dev.tech` (grey-cloud, required)
   and `minio-console.ai5dev.tech` (optional). Repurpose two of the four spare
   names.
4. **Stream server contract unverified** — `STREAM_GRPC_URL` and
   `STREAM_SERVICE_URL` in `.env.dev02` are assumptions. That host was left
   untouched as instructed, so its gRPC port, `GRPC_SERVICE_TOKEN` and
   `JWT_ACCESS_SECRET` were never confirmed. If they differ, stream features
   fail closed. Its firewall must also permit `76.13.216.171`.
5. **Firebase project must be `aimess-app`** — the website's
   `public/firebase-messaging-sw.js` hardcodes that config, and the
   `NEXT_PUBLIC_FIREBASE_*` build values must match it or background push breaks
   while foreground notifications keep working.
6. **TURN is enabled** in `livekit/config.yaml.template`, reusing the existing
   `media.ai5stream.tech` certificate on port 5349. It is inert until that
   record is grey-clouded: TURN speaks TLS on 5349, and a Cloudflare edge is not
   listening there. Until then, clients behind UDP-blocking networks keep
   joining calls and timing out with no media.
7. **Redis is shared with the Wazuh host.** It is fast (0.42 ms) and correctly
   configured, but the app cache and your SIEM now share a failure domain.
   Consider a dedicated Redis on Dev 01 if that matters.
