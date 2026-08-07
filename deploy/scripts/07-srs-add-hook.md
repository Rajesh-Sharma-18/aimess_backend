# Adding a second SRS hook URL (stream server, 72.62.69.126)

This is the **only** change made to the stream server. It is additive and
reversible: the existing hook to `aimess.api.vasundharasolutions.com` stays
exactly as it is, and a second URL is appended so both environments are
notified.

SRS's `http_hooks` accepts a list and POSTs the same event to **every** URL in
it, so adding one does not remove or degrade the other.

---

## Before you start

Read the current state (no changes yet):

```bash
ssh -p 22223 rajvasu@72.62.69.126
sudo grep -n -A8 'http_hooks' /usr/local/srs/trunk/conf/rtmp2rtc.conf
```

Expected today:

```
http_hooks {
    enabled      on;
    on_publish   https://aimess.api.vasundharasolutions.com/internal/srs/hooks?secret=3ffbbfb2c073a9b9f8d52c2235f1341b;
    on_unpublish https://aimess.api.vasundharasolutions.com/internal/srs/hooks?secret=3ffbbfb2c073a9b9f8d52c2235f1341b;
    on_play      https://aimess.api.vasundharasolutions.com/internal/srs/hooks?secret=3ffbbfb2c073a9b9f8d52c2235f1341b;
    on_stop      https://aimess.api.vasundharasolutions.com/internal/srs/hooks?secret=3ffbbfb2c073a9b9f8d52c2235f1341b;
}
```

**There is a live stream running on this box.** Two ffmpeg transcodes were
active at audit time. Do this during a quiet window.

---

## 1. Back up

```bash
sudo cp /usr/local/srs/trunk/conf/rtmp2rtc.conf \
        /usr/local/srs/trunk/conf/rtmp2rtc.conf.bak-$(date +%F-%H%M)
```

## 2. Append the second URL to each hook

Edit `/usr/local/srs/trunk/conf/rtmp2rtc.conf` so each directive lists both
URLs, space-separated, ending in a single `;`:

```
http_hooks {
    enabled      on;
    on_publish   https://aimess.api.vasundharasolutions.com/internal/srs/hooks?secret=3ffbbfb2c073a9b9f8d52c2235f1341b
                 https://api.ai5dev.tech/internal/srs/hooks?secret=3ffbbfb2c073a9b9f8d52c2235f1341b;
    on_unpublish https://aimess.api.vasundharasolutions.com/internal/srs/hooks?secret=3ffbbfb2c073a9b9f8d52c2235f1341b
                 https://api.ai5dev.tech/internal/srs/hooks?secret=3ffbbfb2c073a9b9f8d52c2235f1341b;
    on_play      https://aimess.api.vasundharasolutions.com/internal/srs/hooks?secret=3ffbbfb2c073a9b9f8d52c2235f1341b
                 https://api.ai5dev.tech/internal/srs/hooks?secret=3ffbbfb2c073a9b9f8d52c2235f1341b;
    on_stop      https://aimess.api.vasundharasolutions.com/internal/srs/hooks?secret=3ffbbfb2c073a9b9f8d52c2235f1341b
                 https://api.ai5dev.tech/internal/srs/hooks?secret=3ffbbfb2c073a9b9f8d52c2235f1341b;
}
```

The secret is intentionally the same on both — `SRS_HOOK_SECRET` in
`.env.dev02` is already set to it.

> **Do this only after `api.ai5dev.tech` is live and serving HTTPS.** SRS treats
> a failed `on_publish` hook as a rejection. If the new URL is unreachable,
> whether it breaks the existing environment depends on your SRS version's
> multi-URL failure handling — verify on a throwaway stream key before trusting
> it with real traffic. That is what step 4 is for.

## 3. Validate and reload

```bash
# Parse-check WITHOUT restarting.
sudo /usr/local/srs/trunk/objs/srs -t -c /usr/local/srs/trunk/conf/rtmp2rtc.conf

# Reload in place — does NOT drop live streams (unlike a restart).
sudo pkill -HUP -f 'objs/srs -c conf/rtmp2rtc.conf'

sudo tail -40 /usr/local/srs/trunk/objs/srs.log
```

## 4. Verify both environments receive hooks

Publish to a **throwaway stream key** and watch both sides:

```bash
# New environment (on Dev 02)
docker logs -f aimess-stream-service | grep -i 'srs\|hook'

# Existing environment — confirm it still transitions streams to LIVE
```

Both must log the `on_publish`. If the existing environment stops working,
roll back immediately (step 5).

## 5. Rollback

```bash
sudo cp /usr/local/srs/trunk/conf/rtmp2rtc.conf.bak-<timestamp> \
        /usr/local/srs/trunk/conf/rtmp2rtc.conf
sudo /usr/local/srs/trunk/objs/srs -t -c /usr/local/srs/trunk/conf/rtmp2rtc.conf
sudo pkill -HUP -f 'objs/srs -c conf/rtmp2rtc.conf'
```

---

## Keep stream keys distinct

Both stacks now receive every event for every stream. Each will try to own the
lifecycle of any key it recognises. Because they use separate MongoDB
`stream_db` databases, a key created in one is unknown to the other and its
hook is ignored — which is the behaviour you want.

Do **not** copy stream keys between environments, and do not point both at the
same `stream_db`.

---

## Unrelated bug worth fixing while you are in there

The port-80 block of `/etc/nginx/sites-enabled/ai5stream.tech` reads:

```
server_name ai5stream.tech  www.kai5stream.tech;
```

Note the stray `k` — `www.ai5stream.tech` does not redirect to HTTPS. Fix to
`www.ai5stream.tech`, then `sudo nginx -t && sudo systemctl reload nginx`.
