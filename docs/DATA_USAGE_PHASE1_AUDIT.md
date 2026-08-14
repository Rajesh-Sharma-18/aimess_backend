# Data Usage — Phase 1 Architecture Audit

**Date:** 2026-08-13
**Scope:** `aimess_backend` (all services + packages) and `aimess_website`
**Question asked:** _where does AIMess actually transfer bytes, and which of those bytes can the backend honestly account for per user?_
**Status:** audit only. No code changed.

---

## 0. Executive answer

Two sentences:

1. **Upload bytes are already measured, verified, and stored per user.** Every upload in the product — chat attachment, voice note, document, avatar, cover, backoffice thumbnail — passes through one confirm pipeline that HEADs the object in MinIO and writes the real size to `MediaFile.size`, keyed by `ownerId`. Nothing needs to be built to capture them; they need to be summed.
2. **Download bytes are not measurable at all today, on any surface.** Not partially — no Node process is ever in the download byte path, there is no CDN, and MinIO has no notification or audit sink configured. A "downloaded" number cannot be produced without either changing the transport architecture or trusting the client.

The screenshot's chart is therefore describing a quantity the system cannot currently produce. That is the finding, and it is the thing to decide about before writing any code.

---

## 1. Where AIMess actually transfers bytes

| Surface                                                 | Direction | Where bytes are knowable                                                                                                                                                                                            | Trust                                                                                                                               | Recorded today?                    |
| ------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Chat / group / community attachment                     | UPLOAD    | `head.contentLength` from S3 HeadObject — [magic-validator.ts:135](apps/media-service/src/lib/magic-validator.ts:135); persisted [media.service.ts:374](apps/media-service/src/services/media.service.ts:374)       | server-observed                                                                                                                     | **YES** — `MediaFile.size`         |
| Voice note                                              | UPLOAD    | same registry row (rides `CHAT_ATTACHMENT`)                                                                                                                                                                         | server-observed size, **client-declared kind**                                                                                      | size YES, VOICE-ness NO            |
| Document                                                | UPLOAD    | same                                                                                                                                                                                                                | server-observed                                                                                                                     | YES                                |
| Avatar / cover (user, group, community)                 | UPLOAD    | same confirm pipeline                                                                                                                                                                                               | server-observed                                                                                                                     | YES                                |
| Backoffice livestream thumbnail                         | UPLOAD    | gRPC confirm returns `fileSize` — [media.handler.ts:131](apps/media-service/src/grpc/handlers/media.handler.ts:131)                                                                                                 | server-observed                                                                                                                     | YES                                |
| Attachment `size` on the message row                    | UPLOAD    | `chat-service` schema; validators default it to `0`                                                                                                                                                                 | **client-declared, worthless** — the codebase says so at [attachment-guard.ts:10](apps/chat-service/src/lib/attachment-guard.ts:10) | stored but must not be used        |
| Real wire bytes incl. retries                           | UPLOAD    | `xhr.upload.onprogress` — [mediaUploadQueue.ts:231](../aimess_website/src/services/mediaUploadQueue.ts:231)                                                                                                         | client-declared                                                                                                                     | NO — never leaves the browser      |
| Chat media inline render (**the volume path**)          | DOWNLOAD  | nowhere — `chat-service` presigns per read, [media-resolve.ts:49](apps/chat-service/src/lib/media-resolve.ts:49)                                                                                                    | —                                                                                                                                   | **NO**                             |
| Chat media explicit save                                | DOWNLOAD  | `content-length` + streamed `loaded` — [download.ts:113](../aimess_website/src/utils/download.ts:113)                                                                                                               | client-declared                                                                                                                     | NO — reduced to a percent          |
| Avatar / cover render                                   | DOWNLOAD  | nowhere; ≥6 services presign independently                                                                                                                                                                          | —                                                                                                                                   | **NO**                             |
| Text messages                                           | BOTH      | nothing. The only measurement is a UTF-16 **character** count against the 4000 cap — [private-message.service.ts:177](apps/chat-service/src/services/private-message.service.ts:177)                                | wrong unit                                                                                                                          | NO                                 |
| Voice / video call (LiveKit SFU)                        | BOTH      | server has `Call.durationSec` only; client has `getRTCStatsReport()` used for debug logging                                                                                                                         | duration only                                                                                                                       | **NO**                             |
| Livestream ingest                                       | UPLOAD    | SRS `kbps.recv_30s` — [srs.service.ts:136](apps/stream-service/src/services/srs.service.ts:136)                                                                                                                     | bitrate snapshot                                                                                                                    | last value only, never accumulated |
| Livestream playback                                     | DOWNLOAD  | `watchDurationSeconds` only. Real per-connection egress sits **unread** in SRS `/api/v1/clients/` — [srs.service.ts:209](apps/stream-service/src/services/srs.service.ts:209) destructures only `{id,name,publish}` | time only                                                                                                                           | **NO**                             |
| Livestream `sourceType: YOUTUBE` / `URL`                | DOWNLOAD  | nothing — skips SRS entirely, [livestream.service.ts:308](apps/stream-service/src/services/livestream.service.ts:308)                                                                                               | —                                                                                                                                   | NO, and unknowable                 |
| Giphy / Tenor GIF (send **and** browse)                 | DOWNLOAD  | nothing — media-service short-circuits `http(s)` keys and returns `size: null`, [media.service.ts:482](apps/media-service/src/services/media.service.ts:482)                                                        | —                                                                                                                                   | NO                                 |
| Emoji picker sprites (Apple set, lazy-loaded per glyph) | DOWNLOAD  | third-party CDN                                                                                                                                                                                                     | —                                                                                                                                   | NO                                 |
| Link-host OG images (`aimess.me/<handle>`)              | DOWNLOAD  | `api-gateway` embeds a presigned MinIO URL into `og:image` for crawlers and logged-out visitors                                                                                                                     | **no user to attribute to**                                                                                                         | NO                                 |
| Moderation snapshot reads                               | DOWNLOAD  | community-service presigns reported content for admin review                                                                                                                                                        | wrong user                                                                                                                          | NO                                 |

### Two corrections to circulating claims

- **Calls run on LiveKit, not peer-to-peer.** `useWebRTC.ts` is dead legacy — nothing imports it. Media goes direct over UDP 50000–50100; only signalling is proxied. TURN is disabled in the LiveKit config.
- **There is no CDN in the byte path.** `cdnBaseUrl` is hardcoded `null` in all six backend storage configs, so the CDN branch in `packages/storage/src/media-url-strategy.ts` is dead code. The frontend does define `cdnUrl: process.env.NEXT_PUBLIC_CDN_URL || "https://cdn.aimess.app"` ([app.config.ts:39](../aimess_website/src/configs/app.config.ts:39)), but every use is a **last-resort fallback** for when the server supplied no URL — and since the backend always presigns, that branch produces a broken URL rather than a download. Next's image optimizer is also not in the path: every media `<Image>` is `unoptimized`, deliberately, because the optimizer would strip the presigned query string ([ChatMediaImage.tsx:36](../aimess_website/src/component/chat/messages/ChatMediaImage.tsx:36)).

---

## 2. The download problem

**Verdict: download bytes are unmeasurable today.** Three independent reasons, each sufficient on its own:

1. **No Node process is in the byte path.** Downloads are presigned S3 GETs redeemed directly against MinIO's public endpoint. A repo-wide search for `res.pipe`, `createReadStream`, `res.sendFile`, `transformToWebStream` finds zero byte-serving handlers; the only `GetObjectCommand` consumers are the in-process validation reads. The gateway states it in a comment: uploads and downloads do not flow through it.
2. **There is no presign chokepoint either.** `media.handler.ts` documents that chat-service and user-service bypass `/media/download-url` entirely. At least six services presign independently, plus SRS for livestream playback.
3. **No edge sink.** No CDN (see §1). MinIO is provisioned with buckets and `mc anonymous set none` only — no `mc event add`, no notification or audit webhook env. `MediaFile` has no read counter and no `lastAccessedAt`.

And presign count is decoupled from bytes **in both directions at once**:

- the web client caches a `download-url` response for 50 minutes per objectKey, and the presign itself is valid for up to 7 days → **one mint can back N downloads, or zero**;
- chat-service re-signs on _every_ read, and every mint rotates the SigV4 query string, which changes the browser's HTTP cache key → **re-presigning an unchanged avatar forces a real re-download**.

So "presigns issued" is wrong by an unbounded factor in both directions simultaneously. It is not a proxy for bytes.

### Options, ranked by effort

| #   | Approach                                                                        | What changes                                                                                                                                                                                                   | What you actually get                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Mint-time accounting** — count `MediaFile.size` when a download URL is issued | [media.service.ts:607](apps/media-service/src/services/media.service.ts:607) **and** [media-resolve.ts:49](apps/chat-service/src/lib/media-resolve.ts:49); instrumenting only one misses the majority of reads | Intent, not transfer. Call it "media delivered", never "downloaded".                                                                                                                                                                                                                                                                                                                                                               |
| 2   | **Client-reported telemetry**                                                   | [download.ts:113](../aimess_website/src/utils/download.ts:113) already computes `loaded`/`total`; add a report route                                                                                           | Real bytes, but only for the explicit-save path (one call site). Inline `<img>`/`<video>` stays invisible. Spoofable.                                                                                                                                                                                                                                                                                                              |
| 3   | **Ingest edge access logs**                                                     | HAProxy `be_minio` (`option httplog`) or the nginx MinIO vhost                                                                                                                                                 | The only true per-request byte record. **Blocker: identity** — the URL is signed with the _service's_ credentials and the objectKey path carries the _uploader's_ id, not the downloader's. Needs a per-user marker stamped into every signed URL at ≥6 mint sites. Also UNKNOWN which edge is live: both HAProxy and nginx configs are committed, and `deploy/scripts/09-haproxy-cutover.sh` has no in-repo record of having run. |

**Recommendation:** do not ship a download number in Phase 2. Option 1 is a plausible-looking lie, which §41 of the spec explicitly forbids; option 2 covers the smallest slice of traffic; option 3 is a transport-architecture change. Ship upload-only, labelled honestly.

---

## 3. What already exists that we can ride on

A **verified upload byte ledger already exists and is nearly complete**: `MediaFile` carries `ownerId` + `uploadCategory` + `contentType` + `resourceId` + `createdAt` + a MinIO-verified `size` on one indexed Mongo collection. All four website upload paths and the backoffice gRPC path run the confirm pipeline that writes it.

House patterns to copy rather than invent:

| Need                               | Template                                                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Atomic per-user counter (Postgres) | `Profile.friendsCount` via Prisma `{ increment: 1 }` — `apps/user-service/src/repositories/friendship.repository.ts`                                                                                            |
| Atomic per-user counter (Mongo)    | `unreadCountByUser.<userId>` `$inc` inside `findAndModify` — `apps/chat-service/src/repositories/private-room.repository.ts:330` (comment there records a 1.4s→20s regression that forced the single-step form) |
| Redis hot counter                  | `INCR` + `EXPIRE`-on-first-hit — `apps/auth-service/src/lib/otp-rate-limit.ts:14`                                                                                                                               |
| **Idempotent AMQP ingest**         | unique `eventId` + P2002 swallowed as no-op — `apps/backoffice-service/src/messaging/consume-admin-activity-ingest.ts:45`. Mandatory for anything fed by at-least-once delivery.                                |
| Mongo aggregation                  | `$facet` pipeline — `apps/chat-service/src/repositories/call-analytics.repository.ts:82`                                                                                                                        |
| Periodic job                       | There is no cron. `setInterval` + Redis `SET NX PX` lock + `unref()` + `runOnce()` seam — `apps/notifications-service/src/jobs/device-token-sweeper.ts:31`                                                      |
| REST endpoint (3 files)            | `apps/user-service/src/api/routes/settings.routes.ts:20` + controller; envelope `packages/utils/src/api-response.ts:16` auto-converts `Date` → epoch ms                                                         |
| Gateway routing                    | **nothing to do** — `apps/api-gateway/src/versioning/registry.ts` is a catch-all per-segment proxy. Only OpenAPI needs an entry.                                                                                |
| Donut chart                        | no library needed or present — CSS `conic-gradient`, `_common.scss:5547`                                                                                                                                        |

---

## 4. Absent

- Any per-user or per-category byte counter, quota, meter, column, Redis key, table, event, or endpoint. Anywhere.
- Any download counter, read timestamp, or access record on `MediaFile`.
- Any Node code path carrying object bytes to a client.
- Any CDN in the byte path; any MinIO bucket notification / audit webhook.
- Any metrics stack — no `prom-client`, no OpenTelemetry, no statsd, no `/metrics`.
- Any HTTP byte-accounting middleware — no morgan, no pino-http, no `res.on('finish')`.
- `Buffer.byteLength` — **it appears nowhere in the repo**. Text is measured in UTF-16 code units only.
- A `[ownerId, createdAt]` index on `MediaFile`.
- Any discriminator between client-declared and server-verified size — one `size Int?` column holds both.
- Multipart / chunked / resumable upload. One `PutObjectCommand`; a retry re-sends the whole blob from byte 0.
- Any idempotency key on `/media/upload-url` or `/media/confirm`. A user retry mints a new objectKey and a **new row** — i.e. the ledger already double-counts retried uploads.
- Any use of `MediaFile.fileHash` (written, commented "reserved: dedup", read by nothing).
- Any orphan / abandoned-upload sweep. `setUsage("UNUSED")` has zero production callers despite a dedicated index.
- Any storage cascade on message delete — no `deleteObject` anywhere in `chat-service`. Deleted messages leave `MediaFile` rows `ACTIVE` forever.
- Byte fields on `Call` (only `durationSec`) and on `Livestream`.
- Cron / bullmq / agenda. Bull v4 exists in media-service for AV scanning only.
- Mongo TTL indexes (the helper supports `expireAfterSeconds`; zero call sites).
- MongoDB in CI — `.gitlab-ci.yml` starts only `postgres:16`. Mongo schema changes ship ungated.
- A real Data Usage screen: `USAGE_LEGEND` is four hardcoded rows in `SettingsGeneralPanel.tsx:50` (videos 38%/19.2 MB, messages 31%/15.2 MB, documents 15%/15.2 MB, voice 3%/15.2 MB — three identical placeholder sizes), the donut centre is literal JSX `50` + `MB`, and the SCSS ring stops are normalised against **87**, not 100. QA already tracks it as `BLOCKED`.

---

## 5. Bugs and gaps found during the audit

These are pre-existing, independent of the feature, and worth ticketing separately:

1. **Forwarded media 403s on `/media/download-url`.** Forwarding persists `content` verbatim — same objectKey, no re-upload — but `download-authz` checks membership of `record.resourceId`, which is the **source** room ([download-authz.ts:131](apps/media-service/src/lib/download-authz.ts:131)). A recipient who was never in the source room gets `CHAT_MEDIA_FORBIDDEN`. Inline rendering still works because chat-service presigns directly, so the symptom is "the picture shows but Save fails".
2. **`generateDownloadUrl` can run the full confirm + AV pipeline** when `scanStatus` is null ([media.service.ts:561](apps/media-service/src/services/media.service.ts:561)) — HEAD + magic sample + up to 4 MB container probes, or a full-object read for images/PDF/ZIP, plus an AV job that downloads the whole object. A _download_ call can cost tens of MB of internal MinIO→service egress.
3. **`resolveViewUrlForClient` HEADs MinIO on every avatar read** ([avatar.service.ts:130](apps/user-service/src/services/avatar.service.ts:130)) and discards `head.contentLength`. That is N MinIO round-trips per roster/search render — a latency problem in its own right, and simultaneously the cheapest available download-_intent_ hook, already paid for.
4. **`setVerifiedSize` is best-effort and branch-limited** — swallowed with `.catch(() => undefined)` and only on the structurally-CLEAN branch. REJECTED/ERROR rows keep the client-declared size forever with no marker, and the ERROR branch logs nothing.
5. **Link-host publishes bearer presigns publicly.** `api-gateway` embeds a presigned MinIO URL (1h–7d) into `og:image` on server-rendered `/<handle>` and `/+<code>` pages, readable by any crawler.
6. **`Profile.coverImageUrl` has no plumbing** — a raw string in the public profile contract, with no `USER_COVER` upload category and no presign.
7. **`dataSaverMode` and `autoplayVideos` were deliberately dropped** in `20260520120000_settings_figma_alignment`. The only two levers that would let a user _act_ on a usage number were removed on purpose.

---

## 6. Forced design decisions

Places where the codebase forces a product call the spec left open. Recommendation given for each.

**1. Presign vs transfer.** → **Ship upload-only.** Instrument mint-time with a `requesterId` but do not display it. That record is exactly the correlation key edge-log ingestion would need later.

**2. Avatar noise.** Every avatar presign rotates the signature, changing the browser cache key, so the same 40 KB image re-downloads on every roster render. → **Exclude avatar/cover categories from the meter.** `uploadCategory` already separates them, so it is a `$match` clause. Fix the cause (stable URLs) separately.

**3. Text-message bytes.** Nothing measures them; the only measurement is `String.length`. Group/community fan-out stores **one row per room**, so there is no per-recipient record to attach a received-byte number to. → **`Buffer.byteLength(content.text)` sender-side only**, at the three existing length-check sites. Note it will be a rounding error next to media — the mock's 31% is fiction.

**4. Calls and livestream.** LiveKit media is direct UDP with only signalling proxied; the webhook receiver exists but handles `room_finished`/`participant_left` with a 3-field type. SRS transcodes into 480p/360p renditions, so a single assumed bitrate is wrong per viewer, and `durationSec` is documented as corrupted by stuck IN_PROGRESS calls (median 19s vs mean 4680s). → **Omit both.** Never `duration × assumed bitrate` — an invented number in a data-usage screen is a support-ticket generator.

**5. Which DB.** Strict one-DB-per-service; no shared database. Byte facts live in Mongo `media_db`. → **No new table.** Aggregate `media_files` in place. The repo has two dead speculative read-models proving the failure mode: `GroupIndex` (never written, never read) and `DailyActiveSnapshot` (schema + migration, zero code references). Add a rollup only when the aggregate is measurably slow.

**6. One writer or many.** Every upload already funnels through one confirm pipeline. → **media-service owns it alone.** A new AMQP rail would be the ~25th hand-rolled publisher, and 11 existing ones memoize a channel never reset on close — permanently killing publishes after one broker blip. A meter that silently stops after a RabbitMQ restart is worse than no meter.

**7. Category taxonomy — the spec assumed something false.** `uploadCategory` is a **storage-scope** enum, not a content taxonomy. VIDEO/IMAGE/DOCUMENT derive fine from `contentType` MIME. **VOICE cannot be derived at all** — `packages/constants/src/media/content-type.ts:136` says so verbatim; voice notes are ordinary `audio/*` chat attachments. → Ship **VIDEO / IMAGE / AUDIO / DOCUMENT / OTHER** and rename the screen's "Voice" row to "Audio". True VOICE needs a client-stamped marker at upload time.

**8. Period and reset.** The i18n string bakes a fixed date into all three locales ("Your network usage since Feb 2, 2026, 09:15 AM"), implying a resettable counter. → **Calendar-month window derived from `createdAt`**, no reset button, no new column. Add `usageResetAt` only if product insists.

---

## 7. Concrete Phase 2 shape (upload-only version)

No new model. The aggregate is a query over an existing collection.

1. **One index** — `@@index([ownerId, createdAt])` on `MediaFile`. media-service is MongoDB → `prisma db push`, no migration file. Two gaps to close in the same change: there is no root `db:push:media` script, and media-service is absent from the prod Mongo push table in `deploy/OPERATIONS.md` — without both lines the deploy runbook silently skips it.
2. **One repository method** — `aggregateRaw`: `$match { ownerId, createdAt: {$gte}, scannedAt: {$ne: null}, uploadCategory: {$nin: [avatars/covers]} }` → `$group` by MIME-derived bucket → `$sum: "$size"`. The `scannedAt != null` filter is load-bearing: it is the only signal separating "bytes actually moved" from "a URL was minted and abandoned", since rows stay `PENDING` forever with no orphan sweep.
3. **One route** — `GET /api/v1/media/usage/me`, added beside the existing five in `media.routes.ts`. Zero gateway work (catch-all proxy). Putting it in user-service instead would force a new gRPC RPC for data user-service does not own.
4. **One i18n key set** in `packages/constants/src/messages/` with en/vi/th, or `MessageKey` fails to typecheck.
5. **OpenAPI** path + schema entry.
6. **Frontend** — replace `USAGE_LEGEND` and the literal `50`/`MB` in `SettingsGeneralPanel.tsx`, move the donut stops from SCSS to an inline `conic-gradient`, add the loading/empty/error states, re-author the three i18n strings with `{amount}`/`{date}` placeholders. No shared byte formatter exists — write one.

Response shape:

```
{ periodStart: Date, totalBytes: number,
  byCategory: [{ key: "VIDEO"|"IMAGE"|"AUDIO"|"DOCUMENT"|"OTHER", bytes: number }] }
```

`bytes` as a JS number is safe: per-object ceiling is 100 MB, aggregate stays far under 2^53. Do not widen `MediaFile.size`.

**Known under-counts in this version, to be documented in the UI and the mobile contract:** downloads (all), retried uploads counted once (or twice — see §4), forwarded media attributed to the original uploader, calls, livestream, third-party GIF/emoji/YouTube bytes, and rows created before the deploy.

---

## 8. Honest version vs cheap version

| Fully accurate byte meter                                                                                                                                    | "Good enough, documented limitations"                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Edge log pipeline (HAProxy or nginx → store → parse → aggregate). New infra component.                                                                       | Nothing; downloads not reported.                      |
| Stamp a per-user marker into every presigned URL at ≥6 independent mint sites, because the objectKey path names the _uploader_, not the downloader.          | N/A                                                   |
| Resolve which edge is live (UNKNOWN today).                                                                                                                  | N/A                                                   |
| Widen the LiveKit webhook type **and** the gRPC contract **and** add a byte column to `Call`. UNKNOWN whether the deployed LiveKit even emits byte counters. | CALL omitted; one sentence in the UI.                 |
| Read the SRS per-client egress already being fetched, correlate connection-id→user (SRS hooks carry no userId), de-duplicate the rendition fan-out.          | LIVESTREAM omitted.                                   |
| Client telemetry for inline `<img>`/`<video>` — impossible without a service worker; none exists.                                                            | N/A                                                   |
| Idempotency key on `/media/upload-url` to capture retries without double-counting.                                                                           | Under-counts a 4-attempt upload as 1×. Documented.    |
| Per-recipient text bytes — impossible without per-member message rows.                                                                                       | Sender-side `Buffer.byteLength`, 3 call sites.        |
| Backfill: historical rows carry client-declared sizes with no discriminator.                                                                                 | No backfill; meter starts at deploy.                  |
| Mobile clients instrumented identically, or two-platform users get wrong totals.                                                                             | Server-side only ⇒ platform-agnostic by construction. |
| Rollup table + interval job + retention sweep + durable idempotent event rail.                                                                               | One index, one aggregate, one route.                  |

**Blunt verdict: the current architecture supports the cheap version, and supports it well.** Every byte AIMess can honestly account for already sits verified on `MediaFile`, indexed by owner and time. The honest version is not a bigger feature — it is a **different architecture**: it requires putting something into the byte path (CDN, proxy, or edge-log ingestion with signed per-user markers) that this system was deliberately built to avoid, plus reopening the LiveKit and SRS contracts.

---

## 9. Open questions that block the design

1. **Whose bytes are a forward?** One object, N rooms, and `MediaFile.ownerId`/`resourceId` frozen at the original upload. Until this is decided, no rollup keyed on the registry is fully correct.
2. **Do third-party bytes count?** Giphy browse, emoji CDN, YouTube-sourced livestreams, external `URL` streams. Unambiguously the user's network bytes; unambiguously invisible to AIMess. If yes, the meter becomes client-reported and spoofable. If no, the number will read low against the phone's own OS data meter and users will file it as a bug.
3. **What is the meter actually reporting** — server-verified stored size, or wire bytes? Nothing bridges the two, and only the first is trustworthy.
4. **Anonymous and admin traffic** — link-host crawler pulls, moderation snapshot reads. No user, or the wrong user. Exclude, charge to the owner, or charge to the admin?
5. **Does product still want download controls?** `dataSaverMode` / `autoplayVideos` were deleted deliberately. A usage meter with no lever attached is a number users cannot act on.
