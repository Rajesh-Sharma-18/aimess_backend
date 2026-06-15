# AIMess Media Architecture — Principal Review & Telegram-Parity Plan

**Date:** 2026-06-15 · **Scope:** all media surfaces (private/group/community chat, profiles, community/livestream/admin) · **Status:** review complete; implementation phased & gated on the decisions in §12.

> **TL;DR.** The platform already has a clean, correct, presigned, resolve-on-read media spine (`@aimess/storage` + `@aimess/shared-types` + centralized `media-service`), rich per-file metadata, albums up to 30, and structured location/contact/sticker. Telegram parity is **not a rewrite** — it is four additive deltas: (1) **centralize the drifting message-kind enum**, (2) **widen the MIME/extension allow-lists & make size limits per-category**, (3) **harden upload validation** (extension + magic-byte + virus-scan hook + safe-serving headers), (4) **add the missing kinds** (POLL and friends) where the product wants them. Everything below is backward-compatible by construction.

---

## 1. Current media architecture review

### 1.1 Two-plane design (correct & Telegram-shaped)

- **Control plane — `media-service` (3009/4009).** Issues presigned **PUT** (upload) and **GET** (download) URLs over REST (`/api/v1/media/upload-url`, `/download-url`, `DELETE /uploads/:objectKey`) and gRPC (`GenerateUploadUrl`/`GenerateDownloadUrl`). It never touches file bytes. `apps/media-service/src/services/media.service.ts`, `apps/media-service/src/api/routes/media.routes.ts`, `packages/grpc-contracts/proto/media.proto`.
- **Data plane — client ↔ MinIO directly.** Bytes PUT straight to storage; reads are direct presigned GET. The app tier carries **zero** media bytes → this is the right shape for millions of users.

### 1.2 Shared contract (single source, no duplication)

- `MediaObject` — `packages/shared-types/src/media.ts:1`: `fileId, objectKey, fileName, contentType, size, downloadUrl, downloadUrlExpiresIn, uploadUrl, uploadUrlExpiresIn, uploadHeaders?`. **No** `width/height/duration/thumbnail/blurhash/waveform/mediaType` on the shared object — those live on the **message file object** (see §1.4).
- `toMediaObject()` / `buildUploadMediaObject()` — `packages/storage/src/media-object.ts:26,82`: key → presigned/CDN URL, or builds the upload envelope (`downloadUrl: null` on mint).
- `createMediaUrlStrategy()` — `packages/storage/src/media-url-strategy.ts`: `cdnBaseUrl` set → permanent CDN URL (`expiresIn: null`); else presigned GET with `MINIO_VIEW_EXPIRES_IN` (3600s). **The CDN flip is already wired** — future public-asset cutover is a config change.
- Buckets/prefixes — `packages/storage/src/media-prefixes.ts`: 3 logical buckets (`avatars`, `community`, `chat`); `bucketForKey()` routes by key prefix.

### 1.3 Resolve-on-read everywhere (the load-bearing invariant)

Raw object **keys** are persisted in every DB; a **fresh** presigned URL is generated on **every** read — REST, gRPC, Redis realtime broadcast, and FCM push. The 41-leak audit (`docs/EVENT-MEDIA-AUDIT.md`) is closed. **Rule that must survive every change below: never persist a resolved URL; never let a raw key leave a service boundary.** Resolvers: `@aimess/storage` `toMediaObject` + chat-service `src/lib/media-resolve.ts`.

### 1.4 Message content model (already rich)

- **Message-kind** is the single UPPER field `contentType` on every client surface (private/group/community/REST/socket). Persisted as a Prisma `String` (no Prisma enum), normalized to UPPER on entry. `apps/chat-service/src/lib/chat-message.serializer.ts:17`.
- **Per-file object** (`content.files[]` / community `attachments[]`) already carries: `objectKey, url, name, size, mime, width, height, durationMs, blurhash, waveform` — `apps/chat-service/src/api/validators/private-message.validator.ts:13`, gateway `chat.ns.ts` / `community.ns.ts` send schemas.
- **Albums / media groups:** native — `files[]` up to **30** per message; mixed types allowed; order = array index.
- **Structured non-file kinds:** `location {lat,lng,placeName,placeAddress}`, `contact {name,phone,avatar,userId}`, `sticker {objectKey|url,packId,stickerId}`. Link previews via `urls[]` (≤20).
- **Reply/quote/forward:** `parentMessageId`, `quoteData`, `isForwarded`/`forwardData`.

### 1.5 What's strong (do not touch)

Presigned direct-to-storage · resolve-on-read · additive `MediaObject` + legacy `avatarUrl` kept for old clients · rich client-supplied metadata · centralized media-service · idempotent send via `clientMessageId`.

### 1.6 What's weak (the real gaps)

| #   | Gap                                                                                                                                                                                                                    | Evidence                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| W1  | **Enum drift / not centralized.** Message-kind list is duplicated across Zod validators + OpenAPI with **no `@aimess/constants` source**. Private/group validator is **missing `AUDIO` and `GIF`** that community has. | `private-message.validator.ts:39` vs `community.validator.ts:17`; docs claim "unified" — validators disagree. |
| W2  | **Narrow MIME allow-lists.** Only 12 chat MIME types; no HEIC/HEIF, no mkv/webm/avi/m4v, no m4a/aac/flac, no office (xls/ppt/…), no archives, no code files.                                                           | `apps/media-service/src/config/uploads.ts:12`                                                                 |
| W3  | **Coarse size limits.** One `CHAT_VIDEO_MAX_BYTES` (100MB) covers images, audio, docs, video alike. No per-kind cap.                                                                                                   | `apps/media-service/src/config/uploads.ts:28`                                                                 |
| W4  | **No content verification.** MIME trusted from client header; **no extension check, no magic-byte sniff**.                                                                                                             | `packages/storage/src/validation.ts` (only MIME-whitelist + size)                                             |
| W5  | **No malware scan & unsafe-serving risk.** No virus hook; downloads don't force `Content-Disposition: attachment` / `nosniff` → SVG/HTML stored-XSS vector.                                                            | media-service has no scan/transcode                                                                           |
| W6  | **No server thumbnails/variants.** Only client blurhash; no thumb/medium/original, no video poster, no doc preview.                                                                                                    | no sharp/ffmpeg anywhere                                                                                      |
| W7  | **Missing kinds:** `POLL` (absent), `ANIMATION` (folded into GIF), shared `COMMUNITY`/`USER` references (absent as kinds).                                                                                             | grep: no POLL model                                                                                           |

---

## 2. Missing Telegram media types (the delta)

| Telegram category                                      | Today                                   | Action                                                                                                       |
| ------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Images jpg/png/webp/gif                                | ✅                                      | —                                                                                                            |
| Images **heic/heif**                                   | ❌                                      | add MIME `image/heic`,`image/heif` (+ server transcode-to-jpeg recommended; many browsers can't render HEIC) |
| Animated webp / **animated stickers (tgs/webm)**       | ⚠️ sticker is a ref; formats unenforced | add sticker formats; `ANIMATION` kind decision (§12)                                                         |
| Video mp4/mov                                          | ✅                                      | —                                                                                                            |
| Video **mkv/webm/avi/m4v**                             | ❌                                      | add MIME `video/x-matroska`,`video/webm`,`video/x-msvideo`,`video/x-m4v`                                     |
| Audio mp3/ogg/wav                                      | ✅                                      | —                                                                                                            |
| Audio **m4a/aac/flac**                                 | ❌                                      | add `audio/mp4`,`audio/aac`,`audio/flac`                                                                     |
| Voice ogg-opus / m4a                                   | ⚠️ ogg only                             | add `audio/mp4`; keep `VOICE` kind + waveform                                                                |
| Docs pdf/doc/docx                                      | ✅                                      | —                                                                                                            |
| Docs **xls/xlsx/ppt/pptx/txt/csv/zip/rar/7z/json/xml** | ❌                                      | add MIME set (archives/code = security review, §9)                                                           |
| **Source-code files** (js/ts/py/…)                     | ❌                                      | accept as `text/plain` documents, forced-download (§9)                                                       |
| Stickers                                               | ⚠️ deferred (provider)                  | product decision (memory: blocked on asset source)                                                           |
| Profile avatars/covers/banners                         | ✅                                      | —                                                                                                            |
| Livestream thumbnails/banners/recordings               | ❌ (no stream-service)                  | future; add `LIVESTREAM_*` categories when stream-service lands                                              |
| Contact card                                           | ✅                                      | —                                                                                                            |
| Location                                               | ✅                                      | —                                                                                                            |
| **Poll**                                               | ❌                                      | new kind + sub-doc + vote collection (§3, §12)                                                               |
| Shared link                                            | ✅ `urls[]`                             | optionally promote to `LINK` kind                                                                            |
| **Shared community / user reference**                  | ❌                                      | new kinds `COMMUNITY`/`USER` (refs only — resolve names/avatars on read)                                     |
| Stories (future)                                       | ❌                                      | out of scope                                                                                                 |

---

## 3. Database schema updates

The data model is **Json-flexible**, so almost everything is additive with **no destructive migration**:

- **Message kind** stays a Prisma `String` on the wire — validated against the centralized enum (§4), not a Prisma enum (keeps unknown-tolerance for forward-compat clients).
- **New per-file fields** (`mediaType`, `thumbKey`, `previewKey`, `originalFileName`, `scan: {status}`) → live inside the existing `content`/`attachments` **Json** columns. **No migration.**
- **POLL** → poll definition as a sub-doc in `content.poll {question, options[], settings}` (no migration). **Vote tallies** that must aggregate at scale → a **new `Poll`/`PollVote` collection** (the only genuinely new schema), keyed by `messageId`.
- **Stickers (self-hosted)** → optional new `StickerPack`/`Sticker` Mongo collections (already designed in the deferred plan).
- **Livestream** → defer to stream-service; will reuse `MediaObject` + new bucket/prefix.

## 4. Enum updates — single source of truth (no duplicate system)

**Decision-gated (§12).** Recommended: **centralize, don't duplicate.**

1. New `packages/constants/src/media/content-type.ts`:
   ```ts
   export const CONTENT_TYPES = [
     "TEXT",
     "IMAGE",
     "VIDEO",
     "AUDIO",
     "VOICE",
     "DOCUMENT",
     "GIF",
     "STICKER",
     "ANIMATION",
     "LOCATION",
     "CONTACT",
     "POLL",
     "LINK",
     "COMMUNITY",
     "USER",
     "SYSTEM",
   ] as const;
   export type ContentType = (typeof CONTENT_TYPES)[number];
   ```
2. Every Zod validator (private/group/community) + the gateway send schemas + OpenAPI **import** this — kills W1 drift, restores `AUDIO`/`GIF` to private/group.
3. **`MediaType` = the attachment subset of `ContentType`** (a derived `MEDIA_KINDS` array excluding `TEXT`/`SYSTEM`), **not** a parallel enum — this honors "avoid introducing duplicate media systems." Each file object MAY carry `mediaType` derived from MIME (`mediaTypeFromMime()`).
4. Add `MediaCategoryKey` values as buckets need them (`STICKER`, `GIF` if self-hosted, `LIVESTREAM_*`) — `apps/media-service/src/config/uploads.ts`.

## 5. DTO updates (all optional → backward-compatible)

- File object gains optional `mediaType`, `originalFileName`, `thumbKey`/`thumbnailUrl`, `previewKey`, `scanStatus`. Old clients omit → unchanged behavior.
- Upload request gains optional `originalFileName`; response echoes resolved `thumbnailUrl` once a thumb exists.
- Keep legacy `avatarUrl`/`*ExpiresIn` beside nested `MediaObject` (already the pattern).

## 6. Upload API updates

- **Per-category MIME allow-lists widened** (§2) and **per-kind size limits** introduced: e.g. image 25MB · gif 30MB · video 2GB (multipart) · audio 300MB · voice 25MB · document 200MB · archive 200MB · sticker 1MB. (Final numbers in §12.)
- **Multipart upload** for files > ~100MB: media-service issues multipart presigned part URLs + `CompleteMultipartUpload` — required for Telegram-scale video. (New control-plane methods; data plane still direct-to-MinIO.)
- `originalFileName` passthrough; server derives `mediaType` from MIME.

## 7. Download API updates

- Unchanged for the common path (resolve-on-read already fresh-signs).
- Add **thumbnail/variant** resolution (`?variant=thumb|medium|original`) once thumbs exist.
- **Range requests** are MinIO-native on presigned GET → document for video/audio seek (no code change).
- Safe-serving headers on download (§9).

## 8. Validation rules (defense in depth)

1. MIME in per-category allow-list _(have)_.
2. **Extension in allow-list** _(add)_.
3. **Extension ↔ MIME consistency** _(add)_ — reject `.exe` masquerading as `image/png`.
4. **Size within per-kind cap** _(tighten)_.
5. **Magic-byte sniff** on confirm (read first bytes of the uploaded object via `headObject`/partial GET; verify true type) _(add — see §9)_.
6. **Filename sanitization** (strip path, control chars; cap 255).
7. Object-key ownership _(have)_.

## 9. Security recommendations

- **Trust no client MIME.** Verify magic bytes server-side on an upload-confirm step (new lightweight `POST /media/confirm` or gRPC `ConfirmUpload` that `headObject`s + sniffs + flips `scanStatus`).
- **Virus-scan hook.** Define a `MediaScanner` interface now; wire a ClamAV/cloud engine behind it. **Quarantine** newly-uploaded objects; block download-URL issuance until `scanStatus=CLEAN`. Async worker on a `media.uploaded` event.
- **Force safe serving.** On download, set `Content-Disposition: attachment` for non-inline types and **`X-Content-Type-Options: nosniff`**. **Sanitize or reject SVG/HTML** (stored-XSS). Serve source-code & docs as `text/plain`/attachment, never inline.
- **Block dangerous extensions** (`exe,bat,cmd,sh,js-as-executable,msi,dll,scr`) even inside archives where feasible (note: deep archive inspection is a later phase).
- **Per-user quotas** on top of the existing rate limits (`upload-url` 30/min). Add daily byte quota.
- Keep presigned TTLs short _(have: 900s upload / 3600s view)_.

## 10. Storage architecture recommendations

- **Keep raw keys + resolve-on-read** _(have)_ — the only correct model with expiring URLs.
- **CDN cutover (per-bucket):** flip `cdnBaseUrl` for **public** buckets (avatars, community images, stickers, GIFs) → permanent URLs & edge caching; **keep presigned** for private chat media. Strategy already supports it — make it bucket-aware.
- **Buckets:** add a **`quarantine`** bucket and a **`thumbnails`** prefix/bucket. Lifecycle policies: expire orphaned uploads (PUT-but-never-referenced) after N days; tier cold media.
- **Multipart** for large media (§6). **Thumbnail/transcode workers** (sharp images, ffmpeg video poster + HEIC→jpeg) triggered on confirm — decision-gated (§12).
- **Scale:** direct-to-storage already offloads the app tier; CDN + lifecycle + multipart complete the Telegram-scale story.

## 11. Migration strategy (no breaking Android / iOS / Web / Admin)

**Everything is additive; ship server-tolerant first, clients adopt later.**

1. **Enum centralization is internal** — no wire change; `contentType` stays a `String`; servers tolerate unknown kinds → fallback render. New values (`AUDIO`,`GIF` restored; `POLL`,`ANIMATION`,…) are _accepted_, never _required_.
2. **Widened allow-lists only widen acceptance** — no previously-valid upload breaks. New per-kind limits only tighten the absurd (e.g. 200MB doc cap) and are announced.
3. **New file fields are optional** — old clients ignore them; new clients enrich.
4. **Legacy URL fields retained** beside `MediaObject` — already done; do not remove.
5. **Feature-flag** POLL, thumbnails, virus-scan-blocking so rollout is staged and reversible.
6. **Versioned acceptance window:** servers accept new types/limits in release _N_; FE teams adopt in _N+1_; nothing forces lockstep.

---

## 12. Decisions required before implementation

These genuinely shape the build and carry product/security/cost trade-offs:

- **D1 — Implementation scope this session** (foundation only vs +POLL vs design-only vs all).
- **D2 — Format set to accept now** (HEIC/HEIF · extra video · extra audio · office docs · archives · source-code) — archives & code files carry malware/XSS risk.
- **D3 — Thumbnail & virus-scan strategy** (hook-interface-only for V1 vs build sharp/ffmpeg + scanner pipeline now vs defer).

Enum approach (D-implicit): **recommended to extend the existing `contentType` as the single source of truth** and treat `MediaType` as its derived subset — not a parallel enum — per "avoid duplicate media systems." I'll proceed that way unless told otherwise.

---

## 13. Recommended phased plan

- **Phase 1 — Foundation (safe, additive, ~1–2 sessions).** Centralize `ContentType` in `@aimess/constants`; reconcile drift (restore AUDIO/GIF); widen MIME/extension allow-lists; per-kind size limits; extension+consistency validation; filename sanitization; safe-serving headers; `MediaScanner` **interface** + quarantine plumbing (no engine). Backward-compatible.
- **Phase 2 — Hardening.** Magic-byte verify on confirm (`ConfirmUpload`); wire a real scanner; per-user quotas; multipart for large files.
- **Phase 3 — Enrichment.** Server thumbnails/transcode workers (HEIC→jpeg, video poster, doc preview icon); `?variant=` download.
- **Phase 4 — New kinds.** POLL end-to-end (+ vote collection); shared COMMUNITY/USER references; ANIMATION; promote LINK.
- **Phase 5 — Provider/infra.** Sticker/GIF provider decision; CDN per-bucket cutover; livestream media when stream-service ships.

Per `CLAUDE.md`, each implementation phase runs through the review team (Pro Coder → DRY + Contract reviewers → Quality Tester) before sign-off.
