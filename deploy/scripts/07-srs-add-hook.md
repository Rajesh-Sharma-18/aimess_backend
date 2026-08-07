# SRS publish authorisation — the three-instance topology

**Status: both hook-bearing SRS instances point at `api.ai5dev.tech` as of 2026-08-07.**
RTMP (OBS/iOS) and WHIP (browser camera) were verified publishing end to end on
that date. Livestreams on the old environment (`13.203.130.146`) are
consequently disabled on this host — that trade-off was approved, as
ai5dev.tech replaces it.

---

## 1. The trap: there are THREE SRS installs, in three separate prefixes

`ai5stream.tech` (`72.62.69.126`) does **not** run one SRS with two config
files. It runs three independent installations, each with its own `conf/`
directory, its own log and its own process:

| Role     | Prefix                     | Config               | Listens                                           | Hooks                    |
| -------- | -------------------------- | -------------------- | ------------------------------------------------- | ------------------------ |
| **I-01** | `/usr/local/obs/srs/trunk` | `conf/srs.conf`      | **RTMP `:1935`** (public), api `:1984`            | **yes** — OBS/iOS ingest |
| **I-02** | `/usr/local/srs/trunk`     | `conf/rtmp2rtc.conf` | **WebRTC UDP `:8000`**, rtmp `:1937`, api `:1985` | **yes** — WHIP ingest    |
| **I-03** | `/usr/local/hls/srs/trunk` | `conf/srs.conf`      | rtmp `:1936`                                      | **no** — HLS writer only |

> **`/usr/local/srs/trunk/conf/srs.conf` is stock, unused, and hook-free.**
> It is the file you reach for by reflex and it is the wrong one. The RTMP
> instance's config lives under `/usr/local/obs/`. Resolve the truth with:
>
> ```bash
> for p in $(pgrep -f objs/srs); do
>   echo "$p  cwd=$(sudo readlink -f /proc/$p/cwd)  $(tr '\0' ' ' </proc/$p/cmdline)"
> done
> sudo ss -lntup | grep -E ':(1935|1936|1937|1984|1985|8000)\b'
> ```

**Both hook-bearing instances must be repointed together.** Repointing only one
splits authorisation by protocol: the environment owning I-01's hooks can
publish RTMP but not WHIP, and vice versa. That is exactly what happened
between 11:02 and 13:35 on 2026-08-07 — I-02 was repointed alone, producing a
"works over camera, rejected over OBS" split that looked like two broken
servers and was one half-migrated host.

### The RTMP path fires the hook twice — this is fine

I-01 forwards every publisher to `127.0.0.1:1936` (I-03) **and**
`127.0.0.1:1937` (I-02, so RTMP is playable over WebRTC). I-02 runs its own
`on_publish` for that forwarded copy, so the backend sees two `on_publish`
calls for one broadcast. `handlePublish` returns `true` on an already-LIVE
stream without re-broadcasting, so the second call is a no-op. Verified:
`on_publish ok` at I-01 `13:54:25` and I-02 `13:54:26` for the same key.

---

## 2. Why not two hook URLs — what was measured

`on_publish` is what flips a stream `PENDING → LIVE`. SRS calls **every** URL in
the `http_hooks` list and **rejects the publish if any returns a non-zero body**.

Probing our endpoint with a stream key we do not own:

```
POST https://api.ai5dev.tech/internal/srs/hooks?secret=…
{"action":"on_publish","app":"live","stream":"unknown_key_not_in_our_db"}

→ HTTP 200, body: 1        # 1 = DENY
```

`handlePublish` denies an unknown key, which is correct on its own — it stops
strangers publishing to arbitrary keys. But it means:

| Publisher                  | Old env hook | Our hook     | Outcome              |
| -------------------------- | ------------ | ------------ | -------------------- |
| Existing production stream | `0` allow    | **`1` deny** | **publish rejected** |
| New ai5dev stream          | **`1` deny** | `0` allow    | **publish rejected** |

Two environments cannot share one SRS through publish hooks — each database is
authoritative only for its own keys, so each denies the other's. `on_unpublish`,
`on_play` and `on_stop` return `0` for unknown keys and are harmless, but none
of them marks a stream LIVE.

If both environments must stream from this host simultaneously, the only
workable shape is a **local resolver**: point both instances at one endpoint
that asks ai5dev first, falls back to the old backend, and allows if either
says `0`. Not deployed — the old environment is being retired.

---

## 3. How the repoint was applied

Same procedure for each instance, one at a time, publishers drained first:

```bash
D=/usr/local/obs/srs/trunk          # then /usr/local/srs/trunk for I-02
cp -a $D/conf/srs.conf $D/conf/srs.conf.bak-$(date +%F-%H%M%S)
sed -i 's|https://aimess.api.vasundharasolutions.com|https://api.ai5dev.tech|g' $D/conf/srs.conf
cd $D && ./objs/srs -t -c conf/srs.conf     # MUST print "test is successful"
kill -HUP <pid>                             # same pid, no restart, no dropped streams
```

Backups on the host: `srs.conf.bak-2026-08-07-133430` (I-01) and
`rtmp2rtc.conf.bak-2026-08-07-110157` (I-02). `SRS_HOOK_SECRET` is identical in
both configs and in `.env.dev02`, so only the host changed.

Reload is genuinely in-place — SRS logs `reload config success, state=90` and
keeps the same PID. A live WHIP broadcast with 5 viewers ran throughout the
I-01 reload untouched.

---

## 4. The other half of the bug: the sweeper killed streams anyway

Fixing the hooks was necessary but not sufficient. `findStaleLiveStreams` split
"host stopped heartbeating" from "host never heartbeated", but the Mongo
connector orders `null` below every date, so the `lastHeartbeatAt < cutoff`
branch matched null too — **every stream was ENDED on the first 30 s sweeper
tick after going live**, five minutes before its timeout.

It did not just end early, it poisoned the key: `on_publish` denies an `ENDED`
stream, so every retry on that key was refused. That is the permanent
"Could not access the specified channel or stream key" in OBS.

Measured before the fix: a LIVE stream with a null heartbeat ENDED after 34 s,
while an identical one with a fresh heartbeat was still LIVE at 137 s.

OBS was hit hardest, because the host broadcasts from OBS rather than the app —
the client heartbeat may never arrive at all. `pollObsStreamQuality` already
confirms SRS is receiving frames every tick, so it now also refreshes
`lastHeartbeatAt`; without that a healthy OBS broadcast still died, just at
5 minutes instead of 30 seconds.

Fixed in `50e51392`. Verified after deploy:

| Probe                          | Expected | Result               |
| ------------------------------ | -------- | -------------------- |
| null heartbeat, just went LIVE | survives | **LIVE at 128 s** ✅ |
| heartbeat stale by 10 min      | ends     | **ENDED** ✅         |
| null heartbeat, LIVE 10 min    | ends     | **ENDED** ✅         |

---

## 5. Polling reconciliation (keep it)

`reconcileWithSrs()` runs on the 30 s tick, lists every publisher SRS actually
has open and resolves them against the database. It handles both directions —
including a `PENDING`/`RECONNECTING` stream that SRS is actively carrying, which
gets `handlePublish()` called on it.

```
SRS  ──(30s poll: GET /api/v1/streams/)──►  stream-service
                                              │
                        PENDING + SRS publishing → handlePublish() → LIVE
```

A dropped hook delivery self-heals into a ≤30 s delay instead of a stream stuck
in `PENDING` forever. It does **not** remove the need for the hooks to address
this environment: SRS still asks permission to publish, and a refusal stops the
media before any of this runs.

---

## 6. Configuration this depends on

| Variable             | Value                           | Note                                                                                                                                                                         |
| -------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SRS_API_URL`        | `https://ai5stream.tech`        | **Bare origin.** The code appends `/api/v1/streams/`. Setting `…/api` yields `/api/api/v1/streams/`, which returns the API index and still answers `200` — it fails silently |
| `SRS_INGEST_API_URL` | `https://ai5stream.tech/ingest` | I-01's API (`:1984`). OBS streams land here, not on `SRS_API_URL`'s instance. Used by `kickStream` and `pollObsStreamQuality`. Verified `200` with the stream listed         |
| `SRS_API_USERNAME`   | `deploy@gmail.com`              | from the SRS configs                                                                                                                                                         |
| `SRS_API_PASSWORD`   | `deploy.125#`                   | The trailing `#` **is** part of the password despite `#` being a config comment character. Without it the API returns 401                                                    |
| `SRS_HLS_ABR_MASTER` | `true`                          | Playback is the ABR master playlist `…_master.m3u8`; only rendition playlists exist on disk, so a bare `KEY.m3u8` 404s                                                       |

The `srs-abr-supervisor` (`/etc/default/srs-abr`) polls I-01 and I-02 every 2 s
and starts one `srs-abr@<key>.<rendition>` unit per live stream, writing 1080p/
720p/480p/360p into I-03. Verified: 4 rendition units and a 4-variant master
playlist for the OBS test stream.

---

## 7. Rolling back

```bash
sudo cp /usr/local/obs/srs/trunk/conf/srs.conf.bak-2026-08-07-133430 \
        /usr/local/obs/srs/trunk/conf/srs.conf
sudo cp /usr/local/srs/trunk/conf/rtmp2rtc.conf.bak-2026-08-07-110157 \
        /usr/local/srs/trunk/conf/rtmp2rtc.conf
cd /usr/local/obs/srs/trunk && sudo ./objs/srs -t -c conf/srs.conf
cd /usr/local/srs/trunk     && sudo ./objs/srs -t -c conf/rtmp2rtc.conf
sudo pkill -HUP -f 'objs/srs -c conf/srs.conf'
sudo pkill -HUP -f 'objs/srs -c conf/rtmp2rtc.conf'
```

That restores livestreams on `13.203.130.146` and disables them here again.
Only one environment can own the hooks. **Roll back both or neither** — a
one-sided rollback recreates the protocol split.

---

## 8. Verifying a publish without the app

Mint a throwaway stream, publish a test pattern, then delete it:

```bash
# 1. on Dev 01 — create the key
docker exec -i aimess-mongodb mongosh -u aimess -p '<pw>' \
  --authenticationDatabase admin --quiet stream_db --eval '
  db.livestreams.insertOne({communityId:"probe",creatorId:"probe",
    title:"probe",description:"",sourceType:"OBS_RTMP",streamKey:"probe123",
    status:"PENDING",commentStatus:true,viewerCount:0,peakViewers:0,
    totalViews:0,totalComments:0,createdAt:new Date(),updatedAt:new Date()})'

# 2. on the stream server — publish
ffmpeg -re -f lavfi -i testsrc=size=1280x720:rate=30 -f lavfi -i sine \
  -c:v libx264 -preset ultrafast -c:a aac -shortest -t 60 \
  -f flv rtmp://ai5stream.tech/live/probe123

# 3. confirm which backend authorised it
grep -a probe123 /usr/local/obs/srs/trunk/objs/srs.log | grep on_publish
#    want: "on_publish ok ... url=https://api.ai5dev.tech"
```

Then delete the probe row. A bogus key must log `on_publish failed` against
`api.ai5dev.tech` — that one line proves the wiring independently of the app.

---

## 9. Unrelated bug on that host

The port-80 block of `/etc/nginx/sites-enabled/ai5stream.tech` reads:

```
server_name ai5stream.tech  www.kai5stream.tech;
```

Note the stray `k` — `www.ai5stream.tech` does not redirect to HTTPS. Fix to
`www.ai5stream.tech`, then `sudo nginx -t && sudo systemctl reload nginx`.
