# Media & File Upload Security Audit

**Date:** 2026-08-13
**Scope:** every upload entry point, every supported media/file type, and every path that stores, scans, authorizes, serves or deletes an uploaded object, across all 9 services and the shared packages.
**Method:** full-repository static audit (12 parallel read-only sweeps over `apps/*` and `packages/*`, every claim anchored to `file:line`), followed by implementation and automated verification.

---

## Executive Summary

The platform already had the _skeleton_ of a real upload-security pipeline — presigned uploads, a magic-byte checker, a ZIP inspector, a ClamAV integration, a scan-status gate and a media registry. The skeleton was sound. The problem was that **almost every load-bearing joint had a bypass**, and several of the pieces were wired to nothing at all.

Four findings made the entire pipeline optional:

1. **`/media/confirm` trusted a client-supplied `contentType`** and used it to choose which checks to run. Declaring `text/plain` reached an empty magic-byte accept-set and skipped every structural check — for any bytes at all. _(CRITICAL-1)_
2. **`/media/upload-url` returned a 7-day presigned GET before anything was scanned.** The scan gate lives in `generateDownloadUrl`, not in storage, so those bytes were downloadable the instant the PUT landed. _(CRITICAL-2)_
3. **chat-service never consulted media-service.** It presigned MinIO directly on every read and validated attachments only against client-declared `size`/`mime` — both of which default to falsy and self-disable. No scan verdict, no ownership check, no room-scope check. _(CRITICAL-3)_
4. **The registry's durable `scanStatus` was never written.** `setScanStatus` had zero production callers; every verdict lived only in a Redis key with a 7-day TTL. _(HIGH-2)_

Alongside these, two entire upload paths (user avatars, livestream thumbnails) ran their own weaker validation, no image/video/audio was ever decoded or measured (no dimension, pixel, frame or duration limits existed anywhere), and no orphan cleanup existed in any form.

**Everything CRITICAL and HIGH is now fixed and covered by tests.** The pipeline is centralized: all five upload paths converge on one policy in media-service. 94 new tests were added (media-service 86 → 180, all green) plus 14 in chat-service.

**Headline residual risks:** ClamAV is still `false` by default in every environment (deployment decision, see REMAINING-1), and no re-encoding/transcoding is performed (REMAINING-2).

---

## Supported Media Types

Derived from `apps/media-service/src/config/uploads.ts`. "Deep validation" means the file's own structure is walked, not just its first bytes.

### Images — all categories

| Format   | MIME         | Ext  | Magic bytes                 | Deep validation                                                  | Cap   |
| -------- | ------------ | ---- | --------------------------- | ---------------------------------------------------------------- | ----- |
| JPEG     | `image/jpeg` | jpg  | `FF D8 FF`                  | marker chain → SOF dimensions, EOI, EXIF/GPS/XMP/IPTC/ICC        | 25 MB |
| PNG      | `image/png`  | png  | `89 50 4E 47 0D 0A 1A 0A`   | chunk walk → IHDR dims, APNG frame count, IEND                   | 25 MB |
| WebP     | `image/webp` | webp | `RIFF....WEBP`              | chunk walk → VP8/VP8L/VP8X dims, ANMF frame count, animated flag | 25 MB |
| GIF      | `image/gif`  | gif  | `GIF87a` / `GIF89a`         | block walk → screen dims, per-frame count, trailer               | 30 MB |
| **HEIC** | `image/heic` | heic | ISOBMFF `ftyp` + HEIF brand | box walk → `meta/iprp/ipco/ispe` dims                            | 25 MB |
| **HEIF** | `image/heif` | heif | ISOBMFF `ftyp` + HEIF brand | same                                                             | 25 MB |

HEIC/HEIF are **newly supported** (`uploads.ts:30-38`). They were previously excluded by MIME string only — which did not keep the bytes out, because HEIC and MP4 share the `ftyp` box and the old `????ftyp` signature rule accepted a HEIC as `video/mp4`. Brand-aware detection (`magic-bytes.ts#isobmffMime`) is what actually separates them.

Avatars/covers accept the same six image types (`AVATAR_MIME`), capped at 5 MB.

### Video — chat categories

`video/mp4` (mp4), `video/quicktime` (mov), `video/x-matroska` (mkv), `video/webm` (webm), `video/x-msvideo` (avi), `video/x-m4v` (m4v). Cap 100 MB.
Deep validation: ISOBMFF box walk (`mvhd` duration, `tkhd` track dimensions) with a **tail probe** so non-faststart MP4s still yield their duration; EBML walk for Matroska/WebM (`TimecodeScale`, `Duration`, `PixelWidth/Height`); `avih` for AVI.

### Audio / voice notes

`audio/mpeg`, `audio/ogg`, `audio/wav`, `audio/mp4`, `audio/x-m4a`, `audio/aac`, `audio/flac`. Cap 25 MB.
Deep validation: WAV `fmt`+`data` → exact duration; FLAC STREAMINFO → exact duration; Ogg last-page granule → duration; MP3 frame header → CBR duration estimate; AAC **two chained ADTS frames** (the closest thing raw AAC has to a signature).

### Documents

`application/pdf`, `application/msword`, `application/vnd.ms-excel`, `application/vnd.ms-powerpoint`, the three OOXML types, `text/plain`, `text/csv`, `application/json`, `application/xml`, `text/xml`. Cap 25 MB.

### Archives

`application/zip`, `application/x-zip-compressed`. Cap 25 MB. No RAR/7z support — and nested archives of any kind are now rejected.

### Stickers & GIFs

Stickers are **not a separate format**. `content.sticker` carries either an `objectKey` (a normal upload of one of the types above — same pipeline, no exception) or an external Giphy/Tenor `url` (no object exists; nothing to scan). Sticker object keys are now verified by the same send-time gate as any other attachment (`attachment-guard.ts`, `extra:` parameter).

### Livestream thumbnails

`image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif`. Cap 5 MB. Newly registered as `LIVESTREAM_THUMBNAIL` in media-service.

---

## Upload Flow

**Before** (five paths, three policies):

```
chat / community / group attachment ─┐
user avatar (via legacy alias)       ├─→ media-service presign → client PUT → /confirm (OPTIONAL, client-driven)
group / community avatar+cover       ─┘
user avatar persist  ────────────────────→ user-service: exists + size + key-owner only, NO scan check
livestream thumbnail ────────────────────→ backoffice: presign → PATCH with a string prefix check, NO validation at all
chat attachment read ────────────────────→ chat-service presigns MinIO directly, NO scan gate
```

**After** (one policy):

```
ANY upload
  ↓ POST /media/upload-url  — category allow-list, per-MIME size cap, resource-membership check,
  ↓                           registry row written (FAIL-CLOSED), NO download URL issued
  ↓ client PUT to MinIO (presigned; Content-Type signed)
  ↓ POST /media/confirm  (or gRPC ConfirmUpload for backoffice)
  ├─ trusted MIME resolved server-side (registry row → MinIO signed metadata; request body IGNORED)
  ├─ HeadObject: exists, real size vs the per-MIME cap
  ├─ magic bytes (fail-closed on any MIME outside the policy map)
  ├─ deep structural inspection: full format walk, dimensions, pixels, frames, duration,
  │   trailing-data (polyglot), active content, declared-vs-detected reconciliation
  ├─ ZIP family: central-directory walk — bomb ratio, absolute expansion ceiling, entry count,
  │   nested archives, executables, encrypted entries, Zip-Slip names, OOXML identity + macros
  ├─ SHA-256 recorded
  └─ ClamAV scan (async Bull worker; inline fallback if the queue is down)
  ↓
  CLEAN/SKIPPED → verdict written to Redis AND the registry
  ANY FAILURE  → verdict written to Redis AND the registry
               → object DELETED from MinIO (failure logged critical, recorded on the row)
               → security event logged
               → coarse error code returned; no detector detail leaves the service
  ↓
  Persisting a reference (chat message / profile avatar / livestream thumbnail)
  re-verifies the verdict over gRPC — FAIL CLOSED.
```

---

## Current Security Architecture

| Layer                                               | Module                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Upload policy (categories, MIME allow-list, caps)   | `apps/media-service/src/config/uploads.ts`                                             |
| Structural limits (pixels, frames, duration, depth) | `packages/constants/src/media/limits.ts` **(new)**                                     |
| Magic bytes                                         | `packages/storage/src/magic-bytes.ts`                                                  |
| Deep format inspection + metadata stripping         | `packages/storage/src/deep-inspect.ts` **(new)**                                       |
| ZIP / OOXML inspection                              | `apps/media-service/src/lib/zip-inspector.ts`                                          |
| Validation orchestration                            | `apps/media-service/src/lib/magic-validator.ts`                                        |
| Antivirus                                           | `apps/media-service/src/lib/scanner.ts` (ClamAV INSTREAM over TCP)                     |
| Quarantine / cleanup / durable verdicts             | `apps/media-service/src/lib/media-cleanup.ts` **(new)**                                |
| Download authorization                              | `apps/media-service/src/lib/download-authz.ts`                                         |
| Registry                                            | `apps/media-service/src/repositories/media-file.repository.ts`                         |
| Cross-service verification                          | `media.proto` `CheckMediaStatus` / `ConfirmUpload` **(new)** + one client per consumer |

---

## Security Findings

Severity: **CRITICAL** (pipeline bypass / malware delivery) · **HIGH** (exploitable, bounded) · **MEDIUM** · **LOW** · **INFO**.

---

### CRITICAL-1 — `/media/confirm` selected its own checks from a client-supplied MIME

- **Component:** media-service · `services/media.service.ts:236-240`, `api/validators/media.validator.ts:70-75`
- **Endpoint:** `POST /api/v1/media/confirm`
- **Current behavior (before):** the request body's `contentType` was passed straight to `validateUpload` as `declaredMime` and to `effectiveMaxBytes` as the cap selector. Nothing compared it to the MIME the upload URL was issued for. The registry row holding that MIME was never read. MinIO's stored Content-Type — which the presigned PUT _signs_, and is therefore trustworthy — was fetched by `headObject` and discarded (only `contentLength` was used).
- **Security impact:** total bypass of structural validation for arbitrary bytes, plus per-MIME size-cap evasion.
- **Attack scenario:**
  1. `POST /media/upload-url {category:"CHAT_ATTACHMENT", contentType:"image/png", contentLength:1024}` → key `chat-uploads/{me}/{uuid}.png`.
  2. PUT an arbitrary payload (the presign signs no Content-Length, so size is unbounded).
  3. `POST /media/confirm {objectKey, category:"CHAT_ATTACHMENT", contentType:"text/plain"}`.
     `text/plain` had an empty magic-byte accept-set → `assertMagicBytesMatch` returned immediately; `ZIP_FAMILY_MIMES` did not match → ZIP inspection skipped; verdict CLEAN. The cap also fell back from `CHAT_IMAGE_MAX_BYTES` (25 MB) to the category ceiling (100 MB).
- **Fix:** `resolveTrustedContentType` (`media.service.ts`) resolves the MIME from the registry row, falling back to MinIO's signed Content-Type. The body field is accepted for backward compatibility and **ignored**.
- **Status:** ✅ Fixed
- **Test:** `tests/media/cleanup.test.ts` (all nine rejection classes), `tests/media/deep-inspect.test.ts` "textual formats (previously unchecked entirely)"

### CRITICAL-2 — `/media/upload-url` issued a 7-day download URL before any scan

- **Component:** media-service · `services/media.service.ts:145-150, 195-196` (before)
- **Current behavior (before):** the upload response carried a presigned GET valid for `MINIO_VIEW_EXPIRES_IN` (default **604800 s / 7 days**), described in-code as "for instant preview".
- **Security impact:** the scan gate is inside `generateDownloadUrl`, not inside storage. That URL is a bearer credential redeemed directly against MinIO, so it served the raw bytes the moment the PUT completed — unscanned, to anyone the uploader forwarded the link to. Combined with CRITICAL-1 this is a general-purpose malware distribution channel that never touches a single check.
- **Attack scenario:** request an upload URL, PUT malware, forward the returned `downloadUrl`. Never call `/confirm`.
- **Fix:** no download URL is returned at upload time. The uploader already holds the file; every other reader goes through `/media/download-url` after a downloadable verdict.
- **Status:** ✅ Fixed (**contract change** — see Backward Compatibility)
- **Test:** `tests/media/upload.test.ts` asserts `media.downloadUrl` is null.

### CRITICAL-3 — chat-service accepted and served any object key, unverified

- **Component:** chat-service · `lib/media-resolve.ts:49-63`, `constants/media-limits.ts:185-315`, all three send services
- **Endpoints:** REST + socket send for private / group / community messages
- **Current behavior (before):** chat-service had **no media-service client at all**. `/media/confirm` was never required and `scanStatus` appeared nowhere in the codebase. Send-time validation (`findMediaLimitViolations`) checked only `file.size` and `file.durationMs` — client-supplied fields that default to `0`/`undefined`, so omitting them disabled both caps. Nothing verified that the object existed, that the sender uploaded it, or which room it belonged to. On read, `resolveMediaUrl` presigned MinIO directly, so the scan gate was never on the path.
- **Security impact:** any authenticated user could attach any object key — including another user's, or one belonging to a different room — and have it fanned out, presigned, to every member of the target room. Unscanned content reached recipients as a matter of course.
- **Attack scenario:** upload malware, skip `/confirm`, send a message referencing the key. Every recipient's client receives a working presigned URL.
- **Fix:** new `CheckMediaStatus` gRPC + `lib/attachment-guard.ts`, called from all three send services. Every referenced object must be **verified** (`downloadable`), **owned** by the sender, and **scoped** to the room being posted to. Fail-closed on an unreachable media-service (503, retryable). Verification at write time keeps the read path a plain presign.
- **Status:** ✅ Fixed
- **Test:** `apps/chat-service/tests/lib/attachment-guard.test.ts` (14 cases)

### CRITICAL-4 — livestream thumbnails had no byte validation whatsoever

- **Component:** backoffice-service · `services/livestream.service.ts:222-272`, `api/validators/livestream.validator.ts:235-244`
- **Endpoints:** `POST /livestreams/:id/thumbnail/presign`, `PATCH /livestreams/:id/thumbnail`
- **Current behavior (before):** the "confirm" step was one string refine — `startsWith("stream/thumbnail/") && !includes("..")`. No HeadObject, no magic bytes, no structural inspection, no AV scan, and no check that the key belonged to _this_ livestream (the prefix is satisfied by every key in the category). The `stream/thumbnail` prefix was absent from media-service's `UPLOAD_CATEGORIES`, so media-service could not confirm, scan, serve or delete these objects at all. The presign signs only Content-Type, so the declared 5 MB was never enforced. Thumbnails are then presigned and served with no scan gate and no `Content-Disposition`.
- **Security impact:** a moderator account (or anything that reaches that endpoint) could store arbitrary content of arbitrary size in a bucket nobody validated, and have it served to viewers.
- **Fix:** `LIVESTREAM_THUMBNAIL` registered as a first-class media-service category; `saveThumbnail` now asserts key ownership by livestream id and calls the new gRPC `ConfirmUpload`, which runs the full shared pipeline and deletes the object on rejection. Fail-closed.
- **Status:** ✅ Fixed
- **Test:** covered by the shared pipeline tests; backoffice path exercised via the mocked confirm client.

### CRITICAL-5 — user avatars were persisted and served without a scan verdict

- **Component:** user-service · `services/avatar.service.ts:24-47, 68-73`
- **Endpoint:** `PATCH /api/v1/users/profiles/me` (`avatarObjectKey`)
- **Current behavior (before):** validation was existence + size + key ownership. `head.contentType` was fetched and ignored. user-service has no media-service client, and it presigns its own avatar GET rather than calling `/media/download-url` — so the scan gate was on neither the write nor the read path. `/media/confirm` is client-driven, so simply never calling it produced an unscanned avatar.
- **Security impact:** an unscanned file served to every consumer of that profile — search results, friend lists, discovery, and other services via `bulkGetUserSnapshots`.
- **Fix:** `assertAvatarVerified` calls `CheckMediaStatus` before persisting; rejects anything not downloadable; fail-closed (503) on an unreachable media-service. Oversize-delete failures are now logged critical instead of being silently swallowed.
- **Status:** ✅ Fixed

---

### HIGH-1 — no image, video or audio was ever decoded or measured

- **Component:** repo-wide
- **Current behavior (before):** no image-processing or media-probing library existed anywhere (`sharp`, `jimp`, `image-size`, `probe-image-size`, `ffmpeg`, `ffprobe`, `mp4box` — zero matches in every `package.json` and in the lockfile). Validation was byte-prefix matching only. Consequences: **no** dimension limit, **no** pixel-count limit, **no** GIF/WebP frame limit, **no** verified duration limit (chat-service capped a client-declared `durationMs`, which is omittable), **no** trailing-data detection, **no** EXIF/GPS handling.
- **Security impact:** decompression bombs (a ~100-byte PNG declaring 64000×64000 expands to ~16 GB of RGBA in any decoder — including every _client_ the file is delivered to), unbounded animation frame counts, and polyglot files (a valid JPEG followed by a ZIP/HTML/executable payload) all passed as valid images. Uploaded photos retained GPS coordinates and device identifiers.
- **Fix:** `packages/storage/src/deep-inspect.ts` — a dependency-free structural inspector covering JPEG, PNG, GIF, WebP, HEIC/HEIF/AVIF, MP4/MOV/M4A, Matroska/WebM, AVI, Ogg, WAV, FLAC, MP3, AAC, PDF and the textual formats. It reads dimensions, pixel count, frame count and duration from the container metadata and rejects on the _declaration_, so a bomb never reaches a decoder. `stripImageMetadata` removes JPEG APPn and PNG ancillary chunks (EXIF/GPS/XMP/IPTC/ICC) by byte surgery, no re-encode.
  Native codecs were deliberately not adopted: each is a platform-specific binary in every service image and is itself a memory-unsafe parser reached by untrusted bytes.
- **Status:** ✅ Fixed (limits + measurement). Re-encoding remains out of scope — see REMAINING-2.
- **Test:** `tests/media/deep-inspect.test.ts` (46 cases: valid files of every format, bombs, polyglots, truncation, HEIC/MP4 confusion, metadata strip round-trip)

### HIGH-2 — the durable scan verdict was never written

- **Component:** media-service · `repositories/media-file.repository.ts:64-77`
- **Current behavior (before):** `setScanStatus` — documented "durable, survives Redis TTL" — had **zero production callers**. Every verdict went to Redis only, under `SCAN_STATUS_TTL_SECONDS` (7 days). Every registry row therefore read `PENDING` forever; `scanDetail`/`scannedAt` were永 null; the `@@index([scanStatus]) // find pending / quarantined` indexed a column no query filtered on. `setUsage` was likewise uncalled, so the `[usageStatus, unusedAt]` "orphan cleanup sweep" index backed a sweep that did not exist.
- **Security impact:** a QUARANTINED verdict evaporated after 7 days or a Redis flush; the object then fell back into auto-confirm, re-validating the entire corpus and stampeding the scan queue. No durable record existed that any object had ever been rejected — an operator query for "find quarantined objects" returned nothing.
- **Fix:** every verdict site writes both Redis and the registry (`media-cleanup.ts#recordVerdict`). The download gate reads Redis first and **falls back to the registry**, so terminal verdicts stay terminal. SHA-256 and the verified size are persisted alongside.
- **Status:** ✅ Fixed
- **Test:** `tests/media/cleanup.test.ts` asserts `setScanStatus` on every rejection path.

### HIGH-3 — three ZIP-bomb bypasses in the inspector

- **Component:** media-service · `lib/zip-inspector.ts`
- **Current behavior (before):** the inspector walked _local file headers_ and trusted their sizes.
  1. **Data descriptor (general-purpose flag bit 3):** the local header carries `compressedSize = 0, uncompressedSize = 0`. `totalUncompressed` summed to 0, and the ratio check skipped itself on its own `> 0` guard. The walk then advanced by 0, landed inside compressed data, and `break`-ed after entry one — so a 10 000-entry archive was inspected one entry deep.
  2. **DEFLATE:** nested-archive detection compared the first bytes of each entry's _compressed_ payload against archive magic numbers. A nested ZIP stored with the default DEFLATE method does not begin with `PK`, so detection only ever worked against uncompressed nesting.
  3. **Forged EOCD:** `findEocd` returned the highest-offset EOCD signature with no validation. Appending a second 22-byte EOCD claiming `totalEntries = 1` defeated the entry-count guard.
     Also: ZIP64 unhandled, encrypted entries invisible (and unscannable by ClamAV), entry names never read at all (no Zip-Slip check), and `detectOoxmlType` substring-searched DEFLATE-compressed bytes so it returned `null` for most real documents — which the caller treated as "cannot tell, accept".
- **Security impact:** ZIP bombs, nested-archive payloads and mislabelled Office documents passed structural validation and were then served to clients with a "scanned" label.
- **Fix:** rewritten to walk the **central directory**, which always carries true sizes, method, flags and names, uncompressed. Adds: EOCD candidate validation against the directory it points at, ZIP64 support, an absolute uncompressed-size ceiling (2 GiB) on top of the ratio, name-based nested-archive and executable rejection, encrypted-entry rejection, Zip-Slip name checks, fail-closed OOXML identification from part names, and VBA/OLE/ActiveX active-content detection.
- **Status:** ✅ Fixed
- **Test:** `tests/media/zip-inspector.test.ts` (31 cases, one per bypass)

### HIGH-4 — GROUP_AVATAR fell open to any authenticated user

- **Component:** media-service · `lib/download-authz.ts:189` (before)
- **Current behavior (before):** `GROUP_AVATAR`'s policy is `GROUP_MEMBER` (`packages/constants/src/media/classification.ts:210`), but `legacyAuthz` had no branch for it and fell off the end into the "avatars/covers are public — no check" tail. Any authenticated user could fetch a private group's avatar whenever the registry row was missing.
- **Aggravating factor:** registry registration was **best-effort** (a swallowed try/catch), so a single Mongo blip during `/upload-url` produced that state permanently — this was not limited to pre-registry objects.
- **Fix:** every non-PUBLIC category now falls back to the uploader-only check. Registration is fail-closed (503) — an object that cannot be authorized later is not minted.
- **Status:** ✅ Fixed
- **Test:** `tests/media/download.test.ts` — 403 for a third party, 200 for the uploader.

### HIGH-5 — a banned group member kept downloading all group media

- **Component:** chat-service · `grpc/service-impl.ts` `CheckMediaAccess` GROUP_CHAT branch
- **Current behavior (before):** `findByRoomAndUser` is a bare `findUnique` with no status filter. Kick and ban keep the membership row and only mutate `status`, so a `BANNED` member satisfied the check indefinitely. The COMMUNITY_CHAT branch already had the correct rule.
- **Fix:** a `BANNED` status now throws `USER_BANNED`, mirroring the community rule. `LEFT` and `KICKED` remain allowed **deliberately** — group history is historical-read by design (a kicked member reads up to `kickedAt`) and revoking their media would break history they can legitimately still see.
- **Status:** ✅ Fixed
- **Test:** `apps/chat-service/tests/grpc/check-media-access.test.ts`

### HIGH-6 — HEIC/AVIF impersonated MP4 (and vice versa)

- **Component:** `packages/storage/src/magic-bytes.ts:89-93` (before)
- **Current behavior (before):** the ISO-base-media signature was four wildcard bytes plus `ftyp`, mapped unconditionally to `video/mp4`. HEIC, HEIF, AVIF, MOV, M4A and MP4 all match it. `video/quicktime`, `video/x-m4v`, `audio/mp4` and `audio/x-m4a` all accepted a detected `video/mp4`.
- **Security impact:** any ISOBMFF file passed as any of five different types, and the "HEIC is excluded" policy was unenforceable — a HEIC declared as `video/mp4` sailed through.
- **Fix:** brand-aware resolution (`isobmffMime`) reads the major and compatible brands before deciding. The inspector then reconciles the detected format against the declaration (`assertDetectedMatchesDeclared`), with an explicit alias table for the families that genuinely share a container.
- **Status:** ✅ Fixed
- **Test:** `tests/media/deep-inspect.test.ts` "distinguishes HEIC from MP4 by ftyp brand".

### HIGH-7 — an unknown MIME disabled the magic-byte check entirely

- **Component:** `packages/storage/src/magic-bytes.ts:230` (before)
- **Current behavior (before):** `if (!acceptSet || acceptSet.size === 0) return;` — a MIME absent from `MAGIC_BYTE_ACCEPT_MAP` (`application/octet-stream`, `application/x-msdownload`, a typo) silently passed. Seven allowed MIMEs also had genuinely empty accept-sets: `text/plain`, `text/csv`, `application/json`, `application/xml`, `text/xml`, `audio/aac`, `video/x-msvideo`.
- **Fix:** an unmapped MIME now **fails closed**. AVI gained a real signature (`RIFF....AVI `). AAC and the textual formats keep an empty set — meaning "no file-level signature, validated structurally instead" — and every one of them now has a real structural check in `deep-inspect.ts` (chained ADTS frames for AAC; UTF-8 validity, no NUL bytes, no foreign magic number and no active-content markers for text).
- **Status:** ✅ Fixed

### HIGH-8 — no orphan cleanup of any kind, and failed deletes were invisible

- **Component:** repo-wide
- **Current behavior (before):** `deleteObject` (`packages/storage/src/buckets.ts:98-104`) had no try/catch, no logging and no return value, and all four call sites awaited it bare. A failed delete either 500'd the request or escaped into Bull — in both cases **after** a terminal "removed" verdict had already been written. A known-malicious object stayed in the bucket with nothing recording that fact.
  Orphan scenarios found, none handled: upload-url issued and `/confirm` never called (no reaper, no lifecycle rule, no TTL on the object); confirm returning ERROR (object explicitly kept); AV retries exhausted (object explicitly kept); a chat message deleted (pure tombstone — there is no media delete RPC); an avatar or community image replaced (old object abandoned); account deletion (no object deleted anywhere).
- **Fix:** `lib/media-cleanup.ts` — `deleteObjectSafely` converts a failure into a structured `severity: "critical"` log and returns whether the bytes are confirmed gone; `quarantineObject` writes the durable verdict first, then deletes, then records the delete failure **on the row** if it failed. `cancelUpload` drives the `usageStatus` lifecycle the schema had already indexed for.
- **Status:** ✅ Fixed for every rejection path and for cancel. Message-lifecycle and replacement orphans remain — see REMAINING-3.
- **Test:** `tests/media/cleanup.test.ts` "cleanup failure is loud, never silently reported as removed".

---

### MEDIUM-1 — the API returned no machine-readable error code

- **Component:** media-service · `middleware/error-handler.ts`
- **Before:** responses were `{ success: false, message }` with a **localized** message. A client switching on the text broke the moment the user's locale changed to `vi` or `th`. Meanwhile the published OpenAPI examples (`docs/openapi/paths/media.paths.ts:358-361`) showed an `error.code` field the runtime never sent.
- **Fix:** `code` added, matching the house convention already used by community-service and chat-service (`errorCode(messageKey)` with an UPPER_SNAKE guard).
- **Status:** ✅ Fixed

### MEDIUM-2 — verdict labels were inverted, and failure classes were indistinguishable

- **Before:** a structural rejection (magic-byte mismatch, ZIP bomb, oversize) was labelled `INFECTED`, while an actual ClamAV detection was labelled `QUARANTINED` — the opposite of what the names imply. `REJECTED` existed in the constants vocabulary and was unused. On download, all of them collapsed to one 403 `MEDIA_QUARANTINED`, so "malware" and "come back in five seconds" were the same response. A too-large file returned HTTP 200 `INFECTED`.
- **Fix:** `REJECTED` for structural failures, `INFECTED` for AV detections, `SKIPPED` when no engine ran (previously written as `CLEAN`, making the distinction invisible in the data). Download maps them to distinct codes: `MEDIA_MALWARE_DETECTED`, `MEDIA_SECURITY_VALIDATION_FAILED`, `MEDIA_SCAN_FAILED`, `MEDIA_SCAN_PENDING`.
- **Status:** ✅ Fixed
- **Test:** `tests/media/cleanup.test.ts` "malware and validation failures are distinguishable to the client".

### MEDIUM-3 — detector internals leaked to the client over the socket

- **Component:** media-service · `lib/scanner.ts#publishScanResult`
- **Before:** the `media:scan_result` payload carried a free-text `reason`, fed with (a) the ClamAV signature name, (b) the structural validator's strings including thresholds and byte offsets — _"ZIP compression ratio 140.0:1 exceeds limit of 100:1"_ — and (c) on terminal Bull failure, whatever error escaped, including MinIO SDK messages naming the endpoint and bucket. An existing test asserted the signature-name leak as intended behaviour.
- **Fix:** the payload is status-only. Detail goes to the audit log and `MediaFile.scanDetail`.
- **Status:** ✅ Fixed
- **Test:** `scanner-notify.test.ts` "carries NO reason field"; `cleanup.test.ts` "never leaks detector internals to the client".

### MEDIUM-4 — gRPC returned raw error text

- **Before:** `callback({code: INTERNAL, message: String(err)})` put whatever escaped on the wire. `ForbiddenError` was mapped to `INTERNAL` on the upload path and `PERMISSION_DENIED` only on download.
- **Fix:** `toGrpcError` maps AppErrors to the right status and emits the stable `messageKey`; anything else becomes a generic `MEDIA_INTERNAL_ERROR` with the detail logged.
- **Status:** ✅ Fixed

### MEDIUM-5 — a >1 MB body or malformed JSON returned 500

- **Before:** `errorHandler` gated on `instanceof AppError` only, so Express's `PayloadTooLargeError` (413) and malformed-JSON `SyntaxError` (400) fell to the generic branch and told the client the server had broken.
- **Fix:** both are mapped to their real status with a proper code.
- **Status:** ✅ Fixed

### MEDIUM-6 — no content hash was ever computed

- **Before:** `MediaFile.fileHash` existed in the schema, annotated "SHA-256 hex (reserved: dedup)", and was never written. Nothing could correlate an incident across objects, and a re-PUT to the same key after a CLEAN verdict (the presigned PUT stays valid for `MINIO_PRESIGN_EXPIRES_IN`, default 900 s) was undetectable.
- **Fix:** SHA-256 computed wherever full bytes are read (structural validation for images/PDFs/archives, and always in the AV worker) and persisted with the verdict. MD5 deliberately not used.
- **Status:** ✅ Fixed (recording). The TOCTOU re-PUT window itself is REMAINING-4.

### MEDIUM-7 — media-service ignored its own downloadable allow-list

- **Before:** `DOWNLOADABLE_SCAN_STATUSES` / `isDownloadableScanStatus` existed in `@aimess/constants` and the service hand-rolled the check, so a status added to the vocabulary would not automatically be blocked.
- **Fix:** the gate calls `isDownloadableScanStatus`.
- **Status:** ✅ Fixed

### MEDIUM-8 — presigned GETs live 7 days and cannot be revoked

- **Component:** `config/env.ts` `MINIO_VIEW_EXPIRES_IN` default `604800` (the SigV4 maximum)
- **Impact:** a leaked URL is a bearer credential redeemable directly against MinIO for a week. A SigV4 presign carries no server-side state, so the only levers are deleting the object or rotating the MinIO credentials (which invalidates every outstanding URL platform-wide).
- **Status:** ⚠️ **Not changed** — lowering it is a product/perf decision (dev02 already uses 3600). Recommendation: set `MINIO_VIEW_EXPIRES_IN=3600` in production. The 7-day _upload-time_ URL, which was the actual bypass, is gone (CRITICAL-2).

### MEDIUM-9 — the CDN branch is an unsigned-URL trapdoor

- **Component:** `packages/storage/src/media-url-strategy.ts:38-43`
- **Behavior:** when `cdnBaseUrl` is set, `resolveDownloadUrl` returns `{cdnBaseUrl}/{objectKey}` — permanent, unsigned, and guessable-from-key (the only secret is the UUID). All six services pass `cdnBaseUrl: null` today and no env var is wired to it.
- **Impact:** setting it would silently disable authorization on every media read.
- **Status:** ⚠️ **Not changed** (dead code path). Flagged so it is not enabled without an authorizing edge in front of it.

### MEDIUM-10 — chat-service edit paths accept unvalidated attachment arrays

- **Component:** `api/validators/group-message.validator.ts` — `files: z.array(z.unknown())`; the private edit schema runs no `enforceMediaLimits`.
- **Status:** ⚠️ **Partially mitigated.** The send-time guard covers sends; edits still bypass `enforceMediaLimits`. See REMAINING-5.

### MEDIUM-11 — `parseObjectKeyFromStored` has no traversal guard

- **Component:** `packages/storage/src/object-key-parse.ts:43-48` — the marker-scan fallback slices from any `/{prefix}/` occurrence without a `..` check. Not currently reachable from a write path (every writer pairs it with `assertObjectKeyOwnedBy`), but the guard is absent.
- **Status:** ⚠️ **Not changed** — latent, no known reachable path.

---

### LOW-1 — the `aimess-stream` bucket was never provisioned

No service called `ensureBuckets` with it, so outside the dev-only `deploy/minio/init-buckets.sh` sidecar it did not exist and never received the CORS rules a browser presigned PUT needs. ✅ **Fixed** — media-service now provisions it.

### LOW-2 — dead `QUARANTINED` branch in confirm

`validateUpload` could never return it. ✅ **Fixed** (removed; the status is now produced only by the AV path).

### LOW-3 — `SKIPPED` was documented but never written

`scanner.ts:210` described it as the dev verdict; every path wrote `CLEAN`, making the download allow-list's `SKIPPED` arm unreachable. ✅ **Fixed**.

### LOW-4 — 429 has no message key

`middleware/rate-limiter.ts` emits a hard-coded English literal, untranslated and un-keyed. ⚠️ Not changed.

### LOW-5 — `/media/download-url` is deliberately unrate-limited

A design choice (`media.routes.ts:28-35`) so a media-heavy view cannot 429. It leaves the authorization oracle unmetered. ⚠️ Not changed — the trade-off is documented in-code.

---

### INFO — verified correct, no change needed

- **Buckets are private.** No `PutBucketPolicy`, no `public-read`, no `mc anonymous set download` anywhere; `deploy/minio/init-buckets.sh:22` explicitly asserts `mc anonymous set none`. `ensureBuckets` applies CORS only. The `["*"]` in `ensureBuckets` is CORS allowed-origins, not a read policy.
- **Object keys are server-generated.** `buildObjectKey` = `{prefix}/{ownerId}/{randomUUID}.{ext}` with the extension derived from the **MIME**, never from the client filename. `sanitizeFileName` strips directory components, control characters, quotes and backslashes from the display filename and caps its length; `assertExtensionMatchesMime` rejects a deceptive one.
- **No multipart anywhere.** File bytes never traverse the API gateway; every body limit is 1 MB.
- **Uploads are authenticated and rate-limited.** Every media route runs `authenticateAccessToken` before `mediaRateLimiter`, so the limiter keys on `userId` rather than IP.
- **Upload-side resource membership is enforced.** `assertUploadResourceAccess` verifies the caller belongs to the room/group/community they are filing an object under.

---

## Format-Specific Findings

**Format validation.** Before: first-4-bytes matching only, with seven allowed types exempt and any unmapped type exempt. After: full structural walk per format, fail-closed on unmapped types, declared-vs-detected reconciliation.

**MIME validation.** Before: the client chose it at confirm time (CRITICAL-1). After: server-resolved from the registry or MinIO's signed metadata.

**Magic bytes.** Before: `????ftyp → video/mp4` conflated six formats (HIGH-6); empty accept-sets and unmapped types skipped the check (HIGH-7). After: brand-aware ISOBMFF, AVI signature added, fail-closed on unmapped.

**Images.** Before: no dimensions, no pixel budget, no trailing-data detection, no metadata handling. After: per-side and total-pixel limits, polyglot rejection, EXIF/GPS/XMP/IPTC/ICC detection and stripping.

**GIF.** Before: 6-byte header check and a 30 MB cap, nothing else. After: GIF87a/GIF89a, full block walk, per-frame count against `maxAnimationFrames`, trailer required, trailing-data rejected, malformed sub-block chains rejected.

**Stickers.** Before: `MEDIA_LIMITS.STICKER` was defined but referenced nowhere, so a sticker had **no size cap on any path**, and `findMediaLimitViolations` explicitly no-op'd for `STICKER`. After: a sticker carrying an `objectKey` goes through the identical pipeline and the identical send-time gate; only external provider URLs pass through, and those reference no object of ours.

**Video.** Before: nothing beyond a container-signature guess and a 100 MB cap; duration was a client-declared field that self-disabled when omitted. After: real duration and track dimensions read from `mvhd`/`tkhd` (with a tail probe for non-faststart files) or EBML/`avih`, enforced against `maxVideoDurationMs` / `maxVideoDimension`. No FFmpeg is invoked, so the command-injection, timeout, memory-limit and stuck-process concerns in the brief do not arise — there is no subprocess in the media path at all. (`FFMPEG_PATH` exists only in stream-service's live re-stream ingest, which handles remote RTMP/HLS URLs, not uploaded files.)

**Audio.** Before: signature-or-nothing; `AUDIO` had no duration cap at all. After: exact duration for WAV/FLAC/Ogg, estimated for MP3, structural validity for AAC, all enforced against `maxAudioDurationMs`.

**Documents.** After: PDF requires `%PDF-` and a `%%EOF`, rejects `/JavaScript`, `/JS`, `/OpenAction`, `/AA`, `/Launch`, `/EmbeddedFile`, `/RichMedia`, `/XFA`, and rejects appended content past the last `%%EOF`. OOXML must be positively identified from its part names and is rejected for VBA projects, OLE embeddings and ActiveX. Text formats must be valid UTF-8, free of NUL bytes, not another format in disguise, and free of `<script>`/`<?php`/`<svg>`/`<!ENTITY>` markers. Legacy CFB Office files are accepted on signature; macro inspection of the OLE stream is **not** implemented (REMAINING-6).

**Archives.** See HIGH-3. Only ZIP is accepted; nested archives of any format are rejected outright, so recursion depth is not a concern. Nothing is ever extracted.

**Antivirus.** ClamAV over the clamd INSTREAM protocol, async via Bull with retries and an inline fallback. Now on every path — including the two that previously had none — with verdicts persisted durably.

---

## MinIO Security Findings

| Check                                            | Verdict                                                                                         |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Buckets not unnecessarily public                 | ✅ private; explicitly asserted in the provisioner                                              |
| Uploaded files cannot be executed                | ✅ object storage; nothing is executed server-side                                              |
| Object keys cannot contain user-controlled paths | ✅ server-generated `{prefix}/{ownerId}/{uuid}.{ext}`                                           |
| User filenames not used as keys                  | ✅ display metadata only, sanitized                                                             |
| Correct Content-Type stored                      | ✅ signed into the presigned PUT                                                                |
| Authorization before access                      | ✅ on `/media/download-url`; **now also at reference-persist time** for chat and avatars        |
| Deleted files actually removed                   | ✅ now verified, and failures are loud                                                          |
| Presigned URL expiry                             | ⚠️ 7 days by default — MEDIUM-8                                                                 |
| Cross-user private media                         | ✅ resource-driven authz; fallback tightened (HIGH-4)                                           |
| Banned users revoked                             | ✅ for community and now group (HIGH-5); private-chat participation is historical **by design** |
| Direct MinIO URLs bypass app authz               | ⚠️ inherent to presigned URLs; MEDIUM-8 is the mitigation                                       |

---

## Media Serving Findings

| Header                             | Status                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Content-Type`                     | Stored at PUT and signed; never overridden at serve time. The MIME allow-list keeps `text/html` and `image/svg+xml` out, so the exposure is bounded.         |
| `Content-Disposition`              | `attachment` forced for every non-media extension on `/media/download-url`, via `ResponseContentDisposition` on the presign — this **does** reach the bytes. |
| `X-Content-Type-Options: nosniff`  | Set on the JSON API response only. It cannot be set on bytes served directly by MinIO.                                                                       |
| `Cache-Control` / `Content-Length` | MinIO defaults.                                                                                                                                              |

**Structural limitation:** bytes are served by MinIO, not by Express, so no application middleware can attach headers to them. Closing this requires an authorizing proxy or CDN edge in front of MinIO — see REMAINING-7. `dispositionForKey` is derived from the MIME allow-list rather than a hand-kept list, so a new codec cannot silently become download-only or a new document type silently inline.

---

## Resource Exhaustion Findings

| Limit                        | Before                                                      | After                                                                                     |
| ---------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| File size                    | ✅ (declared at presign; real size unchecked until confirm) | ✅ real size checked before any memory-loading step                                       |
| Image pixels                 | ❌ none                                                     | ✅ 100 MP                                                                                 |
| Image dimension              | ❌ none                                                     | ✅ 20 000 px/side                                                                         |
| Animation frames             | ❌ none                                                     | ✅ 1 500 (GIF + animated WebP + APNG)                                                     |
| Video duration               | ❌ client-declared, omittable                               | ✅ read from the container                                                                |
| Video resolution             | ❌ none                                                     | ✅ 8 192 px/side                                                                          |
| Audio duration               | ❌ none for `AUDIO`                                         | ✅ read from the container                                                                |
| Archive uncompressed size    | ⚠️ ratio only, bypassable                                   | ✅ ratio + 2 GiB absolute ceiling                                                         |
| Archive file count           | ⚠️ forgeable                                                | ✅ cross-checked against the walked directory                                             |
| Recursion depth              | n/a                                                         | ✅ nested archives rejected outright                                                      |
| Container walk depth / nodes | ❌ none                                                     | ✅ `maxContainerDepth` 16, `maxContainerNodes` 4 096                                      |
| In-memory ceiling            | ❌ full object loaded for ZIP                               | ✅ 64 MB refusal; containers probed via 2 MB head + 2 MB tail                             |
| Processing time              | ⚠️ AV timeout only                                          | ⚠️ AV timeout only — the inspector is bounded by node/depth caps rather than a wall clock |

---

## Logging & Monitoring Findings

Structured `media-security` events now carry `event`, `objectKey`, `ownerId`, `contentType`, `fileSize`, `sha256`, `rejectCode`, `detail`, `width`/`height`/`frames`/`durationMs`, `metadata[]`, `scanner` and a timestamp — **internal only**. Cleanup failures and malware detections are tagged `severity: "critical"` for alerting. File contents are never logged. The client-facing surface carries a coarse code and nothing else.

Event names: `media.structural_pass`, `media.structural_rejection`, `media.malware_detected`, `media.scan_clean`, `media.scan_exhausted`, `media.quarantined`, `media.cleanup_failed`, `media.verdict_persist_failed`, `media.register_failed`, `media.attachment_unverified`, `media.thumbnail_rejected`.

---

## Implemented Changes

### New files

| File                                               | Purpose                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/constants/src/media/limits.ts`           | Structural limits, probe windows, reject-code vocabulary                  |
| `packages/storage/src/deep-inspect.ts`             | Dependency-free deep format inspector + metadata stripping (~1 250 lines) |
| `packages/errors/src/ServiceUnavailableError.ts`   | 503 for fail-closed dependencies                                          |
| `apps/media-service/src/lib/media-cleanup.ts`      | Quarantine, safe delete, durable verdicts                                 |
| `apps/chat-service/src/grpc/media.client.ts`       | Batch verdict lookup                                                      |
| `apps/chat-service/src/lib/attachment-guard.ts`    | Send-time verification gate                                               |
| `apps/user-service/src/grpc/media.client.ts`       | Avatar verdict lookup                                                     |
| `apps/backoffice-service/src/grpc/media.client.ts` | Thumbnail confirm                                                         |
| 4 test suites + `tests/helpers/fixtures.ts`        | Byte-accurate format fixtures                                             |

### Modified

`packages/storage/{magic-bytes,buckets,index}.ts` · `packages/constants/{index,messages/media.messages}.ts` · `packages/errors/index.ts` · `packages/grpc-contracts/proto/media.proto` · `apps/media-service/src/{config/{env,uploads},lib/{magic-validator,zip-inspector,scanner,download-authz,resource-type},services/media.service,repositories/media-file.repository,api/{controllers,validators,routes},middleware/error-handler,grpc/handlers/media.handler,server}.ts` · `apps/chat-service/src/{config/env,grpc/service-impl,services/{private,group,community}-message.service}.ts` · `apps/user-service/src/{config/env,services/avatar.service}.ts` · `apps/backoffice-service/src/{config/env,services/livestream.service}.ts`

### Database / infrastructure

**No migration required.** `fileHash`, `scanDetail`, `scannedAt`, `usageStatus`, `unusedAt` and their indexes already existed in `schema.prisma` — they were simply never written. This work makes them live.

New env vars, all defaulted: `MINIO_BUCKET_STREAM`, `STREAM_THUMBNAIL_MAX_BYTES` (media-service); `MEDIA_GRPC_URL`, `CHAT_MEDIA_VERIFY_ENABLED` (chat-service); `MEDIA_GRPC_URL`, `AVATAR_MEDIA_VERIFY_ENABLED` (user-service); `MEDIA_GRPC_URL` (backoffice-service).

---

## Backward Compatibility

Existing media is untouched: no re-validation sweep, no deletion, no migration. Only newly uploaded or re-confirmed objects meet the new rules.

Three behaviour changes worth calling out:

1. **`/media/upload-url` no longer returns `media.downloadUrl`** (it is `null`). Any client relying on it for instant preview must render from the local file it just uploaded, then fetch a download URL after `/confirm`. This was a genuine security bypass and cannot be preserved.
2. **`/media/confirm` ignores the request's `contentType`.** The field is still accepted, so no client breaks.
3. **Scan-status vocabulary corrected** — `REJECTED` for structural failures (was `INFECTED`), `INFECTED` for AV detections (was `QUARANTINED`), `SKIPPED` when no engine ran (was `CLEAN`). The download gate blocks all of them either way.

Both cross-service gates ship with a kill switch (`CHAT_MEDIA_VERIFY_ENABLED`, `AVATAR_MEDIA_VERIFY_ENABLED`, default **on**) for a controlled rollout against clients that do not yet call `/confirm`. Watch `media.attachment_unverified` to size the gap before turning them back on.

---

## Remaining Risks

**REMAINING-1 · HIGH — ClamAV is disabled by default in every environment.**
`CLAMAV_ENABLED` defaults to `"false"` in `config/env.ts`, in `.env.example`, in `deploy/dev02/.env.dev02.example` and in the live local `.env`. dev01 has no clamav container; dev02 has one behind a `--profile clamav` flag. Structural validation runs regardless, but no malware scanning happens until this is switched on. **Set `CLAMAV_ENABLED=true` in production.** This is a deployment decision, not a code change.

**REMAINING-2 · MEDIUM — no re-encoding or transcoding.**
Metadata is stripped from JPEG and PNG by byte surgery, but images are not re-encoded and video/audio are not transcoded, so a payload hidden inside a _structurally valid_ container (e.g. steganography, or an exploit targeting a specific client decoder) survives. Adding it means a native codec in every service image; the upgrade path is a dedicated sandboxed transcode worker, not an in-process library.

**REMAINING-3 · MEDIUM — lifecycle orphans.**
Deleting a message, replacing an avatar or deleting an account still leaves the object in MinIO. The registry has the columns and indexes for a sweep (`usageStatus`, `unusedAt`), and `cancelUpload` now drives them, but no reaper job exists and there is no media-delete RPC for chat-service to call. Cheapest first step: a MinIO bucket lifecycle rule expiring never-confirmed objects, applied next to the existing `PutBucketCors` call.

**REMAINING-4 · LOW — TOCTOU re-PUT window.**
The presigned PUT stays valid for `MINIO_PRESIGN_EXPIRES_IN` (900 s) after a CLEAN verdict. SHA-256 is now recorded, so a change is _detectable_, but nothing re-checks it. Mitigation: re-verify the digest on download, or shorten the window.

**REMAINING-5 · MEDIUM — chat message EDIT paths.**
The send guard covers sends. `editGroupMessageSchema` still declares `files: z.array(z.unknown())` and the private edit path runs no `enforceMediaLimits`. An edit can therefore still swap in an unverified attachment.

**REMAINING-6 · LOW — legacy CFB Office macros.**
`.doc`/`.xls`/`.ppt` are validated by signature only. OOXML macro detection does not apply to the OLE compound format; parsing it is future work. ClamAV catches known macro malware once enabled.

**REMAINING-7 · MEDIUM — no header layer in front of MinIO.**
`nosniff` cannot reach the bytes while clients fetch presigned URLs directly. Requires an authorizing proxy/CDN edge.

**REMAINING-8 · INFO — working-tree anomaly.**
During this session the repository showed concurrent modifications to files outside this work (api-gateway, auth-service, community-service). Unrelated to the media changes but worth noting before committing.

---

## Testing Results

```
media-service:  180 passed / 180 total   (was 86 — +94)
chat-service:   attachment-guard 14/14 · check-media-access 7/7 · media-resolve 22/22
```

Run with:

```bash
node node_modules/jest/bin/jest.js --selectProjects media-service
```

### Coverage added

| Suite                      | Cases | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deep-inspect.test.ts`     | 46    | valid JPEG/PNG/GIF/WebP/HEIC/HEIF/MP4 with dimension+duration extraction; wrong extension/MIME/magic bytes; corrupted, truncated, empty and header-only files; JPEG+ZIP / JPEG+HTML / JPEG+executable / PNG+ZIP / GIF+script polyglots; decompression bombs (dimension and pixel-budget); GIF and APNG frame limits; video duration and resolution limits; executables/ZIPs/NUL bytes/HTML/XXE/malformed JSON declared as text; PDF active content; HEIC↔MP4 brand confusion; EXIF/GPS detection and strip round-trip |
| `zip-inspector.test.ts`    | 31    | ZIP bombs incl. the data-descriptor and forged-EOCD bypasses; DEFLATE-compressed nested archives; nested rar/7z/gz/iso; embedded executables; encrypted entries; four Zip-Slip name classes; NUL in names; malformed structure; OOXML fail-closed identification; VBA/ActiveX detection                                                                                                                                                                                                                               |
| `cleanup.test.ts`          | 16    | the mandatory contract — for nine rejection classes: request completes with the verdict, object deleted from MinIO, durable verdict persisted, object not downloadable afterwards, no detector detail leaked; cleanup-failure path logs critical and records it on the row without 500-ing; cancel deletes and transitions the row; cancel refuses another user's object                                                                                                                                              |
| `attachment-guard.test.ts` | 14    | verified/owned/scoped accept; unknown, pending, infected, rejected, foreign-owner, foreign-room rejections with distinct codes; poster-frame checking; de-duplication; external-URL passthrough; fail-closed 503                                                                                                                                                                                                                                                                                                      |

### Not covered by automated tests

- A live ClamAV round trip (EICAR is available as a fixture; the scanner is unit-tested against a mocked engine).
- Real MinIO I/O — storage is mocked at the SDK boundary throughout, per the existing harness convention.
- HEIC/MP4 fixtures are synthesised, not camera-produced.

---

## Implementation Summary

```
Files changed        40 (9 new, 31 modified)
Services changed     5  (media, chat, user, backoffice + shared packages)
APIs changed         POST /media/upload-url  — no longer returns a pre-scan download URL
                     POST /media/confirm     — contentType accepted and ignored
                     Error responses         — added `code`
                     Scan-status vocabulary  — REJECTED / INFECTED / SKIPPED corrected
                     gRPC MediaService       — +CheckMediaStatus, +ConfirmUpload
                     Upload categories       — +LIVESTREAM_THUMBNAIL
                     MIME allow-list         — +image/heic, +image/heif
Database changes     none (existing columns and indexes now written)
MinIO changes        aimess-stream bucket now provisioned with CORS
Scanner changes      verdicts persisted durably; sanitized notifications;
                     SHA-256 recorded; correct verdict labels
Tests added          94 media-service + 14 chat-service
Security gaps fixed  5 CRITICAL, 8 HIGH, 7 MEDIUM, 3 LOW
Known limitations    ClamAV off by default; no re-encoding; lifecycle orphans;
                     edit-path attachments; no header layer in front of MinIO
```
