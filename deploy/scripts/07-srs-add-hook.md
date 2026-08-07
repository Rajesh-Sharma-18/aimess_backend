# Livestreams on a shared SRS — why we do NOT add a second hook URL

**Status: SRS hooks were REPOINTED to `api.ai5dev.tech` on 2026-08-07.**
Livestreams on the old environment (`13.203.130.146`) are consequently disabled —
that trade-off was approved, as ai5dev.tech replaces it.

An earlier revision described adding a _second_ `http_hooks` URL so both
environments would be notified. **Do not do that** — see "Why not two URLs"
below. It was tested before applying and would have broken live streams.

## Why the repoint was necessary

SRS delegates publish authorisation to whatever backend its hooks point at. While
they pointed at the old environment, every ai5dev stream key was unknown there and
the publish was refused outright:

```
[ERROR] code=3008(HttpResponseData)(HTTP response data invalid)
  : RTC: http_hooks_on_publish : rtmp on_publish https://aimess.api.vasundhar...
```

Symptom: WebRTC negotiated fine (SRS answered, ICE candidate correct) but
`frames=0`, `publish.active=False`, `recv_bytes` only signalling — and
stream-service logged `notifyWhenPlayable: gave up waiting for frames`.

The polling reconciliation below fixes the `PENDING -> LIVE` transition but
**cannot** work around SRS refusing the publish. Both were needed.

### How it was applied

```bash
cp rtmp2rtc.conf rtmp2rtc.conf.bak-$(date +%F-%H%M%S)      # backup first
sed -i 's|https://aimess.api.vasundharasolutions.com|https://api.ai5dev.tech|g' rtmp2rtc.conf
/usr/local/srs/trunk/objs/srs -t -c rtmp2rtc.conf           # validate BEFORE reloading
kill -HUP <srs-pid>                                         # same PID, no dropped streams
```

Confirmed `reload config success, state=90`, and from the stream server:
`on_publish` for an unknown key returns `1`, the other three return `0`.

---

## Why not two URLs — what was measured

`on_publish` is the hook that flips a stream `PENDING → LIVE`. SRS calls **every**
URL in the `http_hooks` list and **rejects the publish if any of them returns a
non-zero body**.

Probing our endpoint with a stream key we do not own:

```
POST https://api.ai5dev.tech/internal/srs/hooks?secret=…
{"action":"on_publish","app":"live","stream":"unknown_key_not_in_our_db"}

→ HTTP 200, body: 1        # 1 = DENY
```

`handlePublish` returns `false` for an unknown key, which is correct on its own
— it stops strangers publishing to arbitrary keys. But it means:

| Publisher                  | Old env hook | Our hook     | Outcome              |
| -------------------------- | ------------ | ------------ | -------------------- |
| Existing production stream | `0` allow    | **`1` deny** | **publish rejected** |
| New ai5dev stream          | **`1` deny** | `0` allow    | **publish rejected** |

Two environments cannot share one SRS through publish hooks. Each one's
database is authoritative only for its own stream keys, so each denies the
other's. At the time of testing there were **5 active ffmpeg transcodes** on
that box — a real stream was live.

`on_unpublish`, `on_play` and `on_stop` all return `0` for unknown keys and are
harmless, but none of them is what marks a stream LIVE.

---

## What was done instead

`reconcileWithSrs()` in `apps/stream-service/src/services/livestream.service.ts`
already ran on the 30-second sweeper tick, listing every publisher SRS actually
has open and resolving them against the database. It only acted on streams that
were already terminal; everything else hit a `continue`.

It now also handles the opposite direction: a stream we have as `PENDING` or
`RECONNECTING` that SRS is actively carrying gets `handlePublish()` called on it.

```
SRS  ──(30s poll: GET /api/v1/streams/)──►  stream-service
                                              │
                        PENDING + SRS publishing → handlePublish() → LIVE
```

`handlePublish` is safe to call repeatedly — it no-ops on an already-LIVE stream
and resumes a `RECONNECTING` one without re-broadcasting.

**Consequences**

- A dropped or failed hook delivery self-heals instead of stranding a stream in
  `PENDING` forever — worst case it goes LIVE up to 30 seconds late.
- The `PENDING -> LIVE` transition no longer depends on the hook at all.
- It does **not** remove the need for the hooks to address this environment:
  SRS still asks them for permission to publish, and a refusal stops the media
  before any of this runs. That is why the repoint above was also required.

---

## Configuration this depends on

Polling needs the SRS API, which on that host has `http_api { auth { enabled on } }`.
Both values live in `deploy/dev02/.env.dev02`:

| Variable           | Value                    | Note                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SRS_API_URL`      | `https://ai5stream.tech` | **Bare origin.** The code appends `/api/v1/streams/` itself (schema default is `http://localhost:1985`). Setting `…/api` produces `/api/api/v1/streams/`, which returns the API index instead of the stream list — and still answers `200`, so it fails silently |
| `SRS_API_USERNAME` | `deploy@gmail.com`       | from `rtmp2rtc.conf`                                                                                                                                                                                                                                             |
| `SRS_API_PASSWORD` | `deploy.125#`            | The trailing `#` **is** part of the password, despite `#` being a comment character in SRS config. Verified: without it the API returns 401                                                                                                                      |

Verified working from inside the container:

```
SRS_API_URL = https://ai5stream.tech
HTTP 200  code 0  streams 0
```

---

## Rolling back

The pre-repoint config is preserved on the stream server:

```bash
ls /usr/local/srs/trunk/conf/rtmp2rtc.conf.bak-*
sudo cp /usr/local/srs/trunk/conf/rtmp2rtc.conf.bak-2026-08-07-110157 \
        /usr/local/srs/trunk/conf/rtmp2rtc.conf
sudo /usr/local/srs/trunk/objs/srs -t -c /usr/local/srs/trunk/conf/rtmp2rtc.conf
sudo pkill -HUP -f 'objs/srs -c conf/rtmp2rtc.conf'
```

That restores livestreams on `13.203.130.146` and disables them here again.
Only one environment can own the hooks.

`SRS_HOOK_SECRET` in `.env.dev02` matches the value in that config, so nothing
else needs changing either way.

**Keep the polling reconciliation regardless.** It costs one API call per 30s
and is what turns a dropped hook delivery into a 30-second delay rather than a
stream stuck in `PENDING` forever.

---

## Unrelated bug on that host

The port-80 block of `/etc/nginx/sites-enabled/ai5stream.tech` reads:

```
server_name ai5stream.tech  www.kai5stream.tech;
```

Note the stray `k` — `www.ai5stream.tech` does not redirect to HTTPS. Fix to
`www.ai5stream.tech`, then `sudo nginx -t && sudo systemctl reload nginx`.
