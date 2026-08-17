# AIMess Media / File Type Audit

Date: 2026-08-17
Scope: upload → validation → storage → download → sharing, for every image, video,
audio, document, GIF and sticker type the product requires.

The audit was done against the running code, not against documentation. The
existing implementation was treated as the source of truth for what is already
supported; nothing supported was removed, renamed, or re-architected.

---

## 1. Existing supported types

There is exactly ONE media-type system, and it was already in place:

| Layer                      | File                                                                    | Role                                                                  |
| -------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Upload allow-list          | `apps/media-service/src/config/uploads.ts` (`CHAT_MIME`, `AVATAR_MIME`) | MIME → canonical extension, per-MIME byte caps                        |
| Signature policy           | `packages/storage/src/magic-bytes.ts`                                   | file signatures + declared→detected accept map                        |
| Structural inspection      | `packages/storage/src/deep-inspect.ts`                                  | per-format container walk, dimensions/frames/duration/trailing bytes  |
| ZIP / OOXML inspection     | `apps/media-service/src/lib/zip-inspector.ts`                           | bomb ratio, entry count, Zip-Slip, OOXML identity, VBA/active content |
| Pipeline                   | `apps/media-service/src/lib/magic-validator.ts`                         | HEAD → size → magic → structure → ZIP                                 |
| Message kinds              | `packages/constants/src/media/content-type.ts`                          | `IMAGE / VIDEO / AUDIO / VOICE / DOCUMENT / GIF / STICKER / …`        |
| Classification + lifecycle | `packages/constants/src/media/classification.ts`                        | owner type, resource type, scan status, access policy                 |
| Product limits             | `apps/chat-service/src/constants/media-limits.ts`                       | per-message counts, byte caps, durations                              |

### Chat attachments (`CHAT_ATTACHMENT`, `GROUP_CHAT_ATTACHMENT`, `COMMUNITY_CHAT_ATTACHMENT`)

Already supported before this audit:

- **Images** — `image/jpeg` (.jpg), `image/png`, `image/webp`, `image/heic`, `image/heif`
- **GIF** — `image/gif`, classified separately (`contentTypeFromMime` → `GIF`), 30 MB cap of its own
- **Video** — `video/mp4`, `video/quicktime` (.mov, including classic ftyp-less QuickTime), `video/x-matroska` (.mkv), `video/webm`, `video/x-msvideo` (.avi), `video/x-m4v`
- **Audio / voice** — `audio/mpeg` (.mp3), `audio/ogg`, `audio/wav`, `audio/mp4` + `audio/x-m4a` (.m4a), `audio/aac`, `audio/flac`
- **Documents** — `application/pdf`, `application/msword` (.doc), `…wordprocessingml.document` (.docx), `application/vnd.ms-excel` (.xls), `…spreadsheetml.sheet` (.xlsx), `application/vnd.ms-powerpoint` (.ppt), `…presentationml.presentation` (.pptx), `text/plain`, `text/csv`, `application/json`, `application/xml`, `text/xml`
- **Archives** — `application/zip`, `application/x-zip-compressed`

### Avatars / covers / livestream thumbnails

`image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif` — 5 MB.

### Stickers

The sticker pipeline is `stickerSchema` in
`apps/chat-service/src/api/validators/attachment.validator.ts`: `packId` +
`stickerId` plus either an `objectKey` (a normal chat-attachment upload, so
**.webp** and **.png** are supported through the standard pipeline) or an
external `url` (Giphy/Tenor, passed through by `generateDownloadUrl` and skipped
by `attachment-guard`). There is no server-side sticker rendering or transcoding.

### Byte and count limits (existing, unchanged)

| Limit                      | Value                             | Where                              |
| -------------------------- | --------------------------------- | ---------------------------------- |
| Images per message         | 10                                | `MEDIA_LIMITS.IMAGE.maxCount`      |
| Image bytes                | 25 MB (`CHAT_IMAGE_MAX_BYTES`)    | both services                      |
| GIF bytes                  | 30 MB (media-service)             | `CHAT_MAX_BYTES_BY_MIME`           |
| Video bytes                | 100 MB (`CHAT_VIDEO_MAX_BYTES`)   | both services                      |
| Video duration             | 180 000 ms (3 min)                | `MEDIA_LIMITS.VIDEO.maxDurationMs` |
| Voice-note duration        | 300 000 ms (5 min)                | `MEDIA_LIMITS.VOICE.maxDurationMs` |
| Audio bytes                | 25 MB (`CHAT_AUDIO_MAX_BYTES`)    | both services                      |
| Document / archive bytes   | 25 MB (`CHAT_DOCUMENT_MAX_BYTES`) | both services                      |
| Avatar / cover / thumbnail | 5 MB                              | media-service env                  |

These were used as-is. No duplicate constant was created.

---

## 2. Missing types

Measured against the required list, exactly one MIME was missing, plus one
extension spelling that the pipeline rejected despite supporting the format:

| Required                   | Status before     | Notes                                                                                                                                       |
| -------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `.opus` / `audio/opus`     | **MISSING**       | `audio/ogg` carried Opus-in-Ogg, but a client labelling its recording `audio/opus` got 415 `UPLOAD_UNSUPPORTED_CONTENT_TYPE`                |
| `.jpeg`                    | **REJECTED**      | `image/jpeg` canonicalises to `jpg`; a file literally named `photo.jpeg` failed `assertExtensionMatchesMime` with `EXTENSION_MIME_MISMATCH` |
| `.avi` (`video/x-msvideo`) | **BROKEN**        | on the allow-list, but no AVI file signature existed, so every AVI failed `/media/confirm` — see §5                                         |
| `.tgs` (sticker)           | **NOT SUPPORTED** | deliberately not added — see §7                                                                                                             |

Everything else on the required list (JPEG, JPG, PNG, WebP, HEIC, HEIF, GIF, MP4,
MOV, WebM, MKV, MP3, M4A, AAC, WAV, OGG, PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX,
TXT, CSV) was already supported and validated.

---

## 3. Changes made

### 3.1 `audio/opus` (.opus)

| Aspect          | Change                                                                                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension       | `.opus`                                                                                                                                                                                                                                                       |
| MIME            | `audio/opus`                                                                                                                                                                                                                                                  |
| Allow-list      | `apps/media-service/src/config/uploads.ts` — `CHAT_MIME["audio/opus"] = "opus"`                                                                                                                                                                               |
| Size cap        | `CHAT_MAX_BYTES_BY_MIME["audio/opus"] = env.CHAT_AUDIO_MAX_BYTES` (the same 25 MB every other audio MIME uses — no new constant)                                                                                                                              |
| Signature       | `packages/storage/src/magic-bytes.ts` — `MAGIC_BYTE_ACCEPT_MAP["audio/opus"] = {"audio/ogg"}` (Opus is carried in an Ogg container, so it shares `OggS`)                                                                                                      |
| Structural      | `packages/storage/src/deep-inspect.ts` — dispatches to `inspectOgg`, which now **requires an `OpusHead` identification packet** when the declaration is `audio/opus`. Without that, the codec half of the declaration would be the one thing nothing verified |
| Alias           | `DETECTED_MIME_ALIASES["audio/opus"] = {"audio/ogg", "audio/opus"}`                                                                                                                                                                                           |
| Rendering       | `.opus` inherits inline rendering automatically — `INLINE_RENDER_EXTS` is derived from `CHAT_MIME`, not hand-maintained                                                                                                                                       |
| Classification  | no change needed: `contentTypeFromMime("audio/opus")` → `AUDIO`, `resolveResourceType` → `*_CHAT_AUDIO`, data-usage → `AUDIO`                                                                                                                                 |
| Client contract | added to the OpenAPI `CHAT_CONTENT_TYPES` enum                                                                                                                                                                                                                |

No API contract changed shape; one value was added to an existing enum.

### 3.2 Extension spellings (`.jpeg`, `.heif`, `.opus`, …)

`packages/storage/src/validation.ts` — `assertExtensionMatchesMime` now consults a
small `EXTENSION_ALIASES` table before rejecting:

```
jpg  ← jpeg, jpe        heic ← heif        ogg ← oga, opus
heif ← heic             opus ← ogg, oga    wav ← wave
m4a  ← m4b              mp4  ← m4v         m4v ← mp4
```

Only alternative spellings of the _same_ format are listed. An extension naming a
different format (`invoice.html` declared `image/png`) still fails exactly as
before — that is what the check exists for. The stored object key still uses the
MIME-derived canonical extension, so nothing downstream changed.

### 3.3 AVI signature (repair of an existing supported type)

`packages/storage/src/magic-bytes.ts` — added the `RIFF....AVI ` signature. See
§5, finding 1.

### 3.4 Published contract (docs only)

`apps/api-gateway/src/docs/openapi/paths/media.paths.ts`:

- added `image/heic`, `image/heif`, `audio/opus` to the advertised chat MIME enum
- added `LIVESTREAM_THUMBNAIL` to the advertised category enum (media-service
  already accepts it, so the published enum was rejecting a valid call)
- corrected the per-MIME size table, which listed 50/100/10 MB figures that no
  longer matched the env defaults
- stated explicitly that the declared `contentType` is an entry check only, and
  that `/media/confirm` re-derives the MIME server-side

No backend behaviour changed here — this closed a drift between the enforcement
table and the documented contract.

### Frontend

This repository is backend-only. The client-facing contract lives in the
OpenAPI documents above (and in the `aimess-media-upload` integration skill),
both of which now list the full set. Clients that build their file picker from
the published `contentType` enum pick up HEIC/HEIF/Opus without further change.

---

## 4. Existing types preserved

**No supported MIME type, extension, category, validator, constant or status was
removed, renamed, disabled or narrowed.**

Verified concretely: `tests/media/format-matrix.test.ts` derives its fixture
table from `UPLOAD_CATEGORIES.CHAT_ATTACHMENT.allowedMime` itself and asserts
that _every_ entry has a fixture and that every fixture passes both the magic-byte
and the structural layer. A MIME dropped from the allow-list, or added without
validation, fails that suite. All 33 accepted chat MIMEs pass.

Types beyond the required list that were found and kept: `video/x-msvideo`,
`video/x-m4v`, `audio/flac`, `image/avif` (signature layer), `application/json`,
`application/xml`, `text/xml`, `application/zip`, `application/x-zip-compressed`.

---

## 5. Security findings

### Fixed

**1. Every `.avi` upload was rejected — `video/x-msvideo` had an unsatisfiable policy.**
`MAGIC_BYTE_ACCEPT_MAP["video/x-msvideo"]` required a detected `video/x-msvideo`,
but no rule in `SIGNATURES` ever produced that value. `matchMagicBytes` returned
`null` for a perfectly valid AVI, and `assertMagicBytesMatch` fails closed on
`null`, so `/media/confirm` reported `REJECTED` ("no recognisable file signature")
for an accepted, allow-listed type. The accept-set had been tightened (from an
empty "skip validation" set) without adding the signature that makes it
satisfiable. Fixed by adding the `RIFF....AVI ` signature — the strictness is
preserved, the type is repaired.

**2. Legitimate filenames rejected as spoofing attempts.**
`photo.jpeg`, `IMG_0001.heif` under `image/heic`, and `note.opus` under
`audio/ogg` all raised `EXTENSION_MIME_MISMATCH` → HTTP 415. A false positive in a
security check is still a broken feature; fixed with the alias table in §3.2
without weakening the true-positive case.

**3. `audio/opus` was unsupported, and would have been unverifiable if naively added.**
Adding the MIME alone would have accepted any Ogg stream under an Opus label. The
`OpusHead` requirement means the codec claim is checked, not just the container.

**4. Published contract drift.** The OpenAPI enum omitted HEIC/HEIF (supported
since the HEIC work) and `LIVESTREAM_THUMBNAIL` (accepted by the validator), and
advertised stale byte caps. Clients generating pickers from the spec would refuse
files the server accepts.

### Audited and found sound (no change made)

- **Client MIME is never trusted as proof of type.** `/media/confirm` ignores the
  request body's `contentType` entirely (kept for backward compatibility) and
  re-derives the MIME from the `MediaFile` registry row, falling back to the
  Content-Type MinIO stored — which the presigned PUT signature binds.
  `evil.exe` declared `image/jpeg` is rejected at the magic-byte layer; declared
  `text/plain` it is rejected by `inspectTextual`'s negative signature.
- **Extension is never the sole mechanism.** The object key's extension is
  server-derived from the MIME, and validation runs on bytes.
- **Fail-closed defaults.** A MIME absent from `MAGIC_BYTE_ACCEPT_MAP` is
  rejected, not skipped. An empty accept-set means "validated structurally
  instead" (raw AAC via ADTS frame-chaining, text/\* via the negative signature) —
  never "unchecked". An unrecognised declared MIME still gets the generic sniff
  pass in `dispatch`'s default branch.
- **Polyglots.** `maxTrailingBytes: 0`, with pure NUL/whitespace padding
  discounted, so a JPEG+ZIP / JPEG+HTML / JPEG+EXE is rejected with
  `TRAILING_DATA`.
- **Decompression bombs.** Pixel/dimension/frame caps are read from the container
  declaration, so the bomb never reaches a decoder. ZIP ratio, entry count,
  nesting, encryption and Zip-Slip are handled by `zip-inspector`.
- **Rejected/infected media cannot be downloaded.** Structural rejection and AV
  detection both call `quarantineObject`, which deletes the bytes from MinIO and
  records the durable verdict. Download is gated by an **allow-list**
  (`DOWNLOADABLE_SCAN_STATUSES = {CLEAN, SKIPPED}`), so any new or unknown status
  defaults to blocked.
- **Deleted media stays deleted.** `cancelUpload` deletes the object and flips
  `usageStatus` to `DELETED`; the durable registry verdict wins over a rolled-over
  Redis cache entry in both `generateDownloadUrl` and `checkMediaStatus`.
- **Object keys are not authorization.** `authorizeMediaAccess` runs _before_ any
  URL is signed and is driven by the registry row's resource type →
  `RESOURCE_ACCESS_POLICY` → chat-service membership over gRPC. The
  key-prefix/uploader fallback applies only to pre-registry rows and is the
  strictest relationship a key alone can prove.
- **The relationship chain required by the spec exists in both directions.**
  Upload: `assertUploadResourceAccess` verifies the caller belongs to the
  `resourceId` before the row is written (`resourceId` is mandatory for the three
  chat categories). Download: registry row → `resourceId` → private-participant /
  group-member / community-member check. Send: `attachment-guard` verifies every
  referenced object is verified, owned by the sender, and scoped to the room being
  posted to — fail-closed on a media-service outage.
- **No private object is made public.** Nothing in this change alters bucket
  policy, presign expiry, or `Content-Disposition` behaviour.

### Open (reported, deliberately not changed)

**A. Product duration limits are not enforced against the real container.**
`MEDIA_LIMITS.VIDEO.maxDurationMs` (3 min) and `MEDIA_LIMITS.VOICE.maxDurationMs`
(5 min) are checked in chat-service against the **client-supplied** `durationMs`,
which defaults to undefined and therefore self-disables. media-service _does_ read
the true duration out of the container, but enforces the structural ceiling
(`MEDIA_STRUCTURAL_LIMITS.maxVideoDurationMs`/`maxAudioDurationMs` = 3 hours), not
the product limit. A 2-hour video under 100 MB is accepted today. The docblock on
`MEDIA_STRUCTURAL_LIMITS` claims these "mirror the caps chat-service already
applies", which is not accurate. **Not changed**: tightening media-service to 3
min / 5 min would start rejecting uploads that are accepted today, and per the
brief a difference in intentional limits is reported before it is changed.

**B. Byte-cap drift between the two enforcement points.** GIF is capped at 30 MB
by media-service but 50 MB by chat-service (`GENERIC_MAX_BYTES`); voice notes at
25 MB by media-service but 50 MB by chat-service. media-service is the stricter of
the two and runs first, so the effective limits are 30 MB and 25 MB — but the two
tables disagree, which is exactly the drift the shared env-var scheme was
introduced to prevent. **Not changed**: both values are plausible product
intentions and picking one silently would change a live limit.

**C. Legacy Office formats are not distinguished from one another.** `.doc`,
`.xls` and `.ppt` share one Compound File Binary signature and
`deep-inspect.dispatch` accepts the declaration as-is for the whole family, so a
`.doc` declared `application/vnd.ms-excel` passes. The OOXML equivalents _are_
distinguished (`detectOoxmlType` fails closed). The risk is mislabelling, not
code execution — the AV scan and the `Content-Disposition: attachment` forced
download both still apply. Closing it needs a CFB directory parser.

**D. `.tgs` stickers are unsupported.** See §7.

---

## 6. Media status / lifecycle

The spec's `UPLOADING / PROCESSING / SCANNING / AVAILABLE / REJECTED /
QUARANTINED / DELETED` model already exists, split across two orthogonal axes.
**No second status system was introduced**; the existing one is reused verbatim:

| Spec state  | Existing representation                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| UPLOADING   | `MediaScanStatus.PENDING` + `MediaUsageStatus.ACTIVE` (row written at upload-url mint)   |
| PROCESSING  | `PENDING` while structural validation runs                                               |
| SCANNING    | `MediaScanStatus.SCANNING`                                                               |
| AVAILABLE   | `CLEAN` (AV ran) / `SKIPPED` (AV disabled) — the `DOWNLOADABLE_SCAN_STATUSES` allow-list |
| REJECTED    | `MediaScanStatus.REJECTED` (structural), plus `MediaRejectCode` internally               |
| QUARANTINED | `QUARANTINED` / `INFECTED`                                                               |
| DELETED     | `MediaUsageStatus.DELETED`                                                               |

---

## 7. `.tgs` stickers — why not added

`.tgs` is a gzip-compressed Lottie JSON animation. Supporting it would require:

- a new MIME (`application/x-tgsticker`) whose only signature is the generic gzip
  header `1f 8b`, indistinguishable from any other gzip payload;
- a decompression step inside the validator — i.e. a second bomb surface, on a
  format whose whole point is a high compression ratio;
- a Lottie renderer on web, iOS and Android, none of which exists in this product.

The brief says not to blindly add unsupported processing libraries and to check
the existing sticker pipeline first. The existing pipeline is objectKey-or-URL
based with `.webp` / `.png` assets, and those work today. `.tgs` is recorded here
as a known gap rather than half-implemented as an unvalidated blob upload.

---

## 8. Tests

### Added — `apps/media-service/tests/media/format-matrix.test.ts` (97 assertions)

- **Coverage guard** — asserts every MIME in `CHAT_MIME` has a fixture, so the
  allow-list and the test table cannot drift.
- **Valid, per format** — JPEG, PNG, WebP, GIF, HEIC, HEIF, MP4, MOV (classic
  ftyp-less QuickTime), MKV, WebM, AVI, M4V, MP3, OGG, OPUS, WAV, M4A (×2 MIMEs),
  AAC, FLAC, PDF, DOC, XLS, PPT, DOCX, XLSX, PPTX, TXT, CSV, JSON, XML (×2), ZIP
  (×2) — each asserted through both `assertMagicBytesMatch` and `inspectMedia`.
- **Extension spellings** — 28 (MIME, filename) pairs minted through the real
  `createUploadUrl`, including `.jpg` **and** `.jpeg`, `.heic`/`.heif`/`.HEIF`,
  `.opus` under both `audio/ogg` and `audio/opus`.
- **Invalid** — unsupported MIME; oversized (per-MIME cap below the category
  ceiling); empty file; extension naming a different format; MIME spoofing (an
  executable declared as each of 8 media types); a MIME with no signature policy
  at all; 9 cross-format spoofs (JPEG-as-PNG, HEIC-as-MP4, MP4-as-HEIC,
  Ogg-as-FLAC, DOCX-as-PDF, …); an Ogg with no `OpusHead` declared `audio/opus`;
  corrupted/truncated PNG, JPEG, GIF, PDF, WAV, Ogg, FLAC and Matroska; and an
  empty object asserted against every accepted MIME.

### Added — `apps/media-service/tests/helpers/fixtures.ts`

Byte-accurate generators for the formats that had none: `validM4a`, `classicMov`,
`validMatroska` (matroska + webm DocTypes), `validWav`, `validMp3`, `validAac`
(chained ADTS frames), `validOgg` (with/without `OpusHead`), `validFlac`,
`validPdf`, `validCompoundOffice`, `buildXlsx`, `buildPptx`. No binary assets were
added to the repository. Existing generators were left untouched.

### Updated — `packages/storage/src/__tests__/validation.test.ts`

Two cases for the extension-alias behaviour: alternative spellings of the same
format are accepted; an extension naming a different format still throws
`EXTENSION_MIME_MISMATCH`.

### Results

```
media-service      15 suites, 295 tests   PASS
@aimess/storage    15 suites,  59 tests   PASS
typecheck          @aimess/storage, @aimess/media-service, @aimess/api-gateway   PASS
```

api-gateway's suite has 9 pre-existing failures in
`tests/sockets/stream-leave-idempotency.test.ts` and `tests/admin/admin-edge.test.ts`.
They are unrelated to this work (the only api-gateway file touched here is a
static OpenAPI document that neither suite imports) and were not introduced by it.

---

## 9. Files changed

| File                                                     | Change                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/storage/src/validation.ts`                     | extension-alias table; `assertExtensionMatchesMime` consults it      |
| `packages/storage/src/magic-bytes.ts`                    | AVI signature (repair); `audio/opus` accept-set                      |
| `packages/storage/src/deep-inspect.ts`                   | `audio/opus` dispatch + `OpusHead` requirement + detected-MIME alias |
| `apps/media-service/src/config/uploads.ts`               | `audio/opus` → `.opus`, reusing the existing audio byte cap          |
| `apps/api-gateway/src/docs/openapi/paths/media.paths.ts` | HEIC/HEIF/opus, `LIVESTREAM_THUMBNAIL`, corrected caps (docs only)   |
| `apps/media-service/tests/helpers/fixtures.ts`           | new format fixtures                                                  |
| `apps/media-service/tests/media/format-matrix.test.ts`   | new suite                                                            |
| `packages/storage/src/__tests__/validation.test.ts`      | extension-alias cases                                                |
| `MEDIA_TYPE_AUDIT.md`                                    | this report                                                          |

No migration is required. No database schema, gRPC contract, socket payload or
REST request/response shape changed.

---

## 10. Remaining gaps

1. Video/voice product duration limits are not enforced against the real
   container duration (§5.A) — needs a product decision before changing.
2. GIF and voice-note byte caps disagree between chat-service and media-service
   (§5.B) — needs a product decision on which value is correct.
3. Legacy Office formats are not told apart from one another (§5.C).
4. `.tgs` stickers unsupported (§7).
5. `image/avif` is understood by the signature and structural layers but is not on
   the upload allow-list. Left as-is: it was not requested, and adding it is a
   one-line change if it ever is.

## 11. Confirmation

No existing supported media or file type was removed, disabled, renamed, or
replaced. No existing validation rule was weakened. No duplicate constant,
validator, media category or status system was introduced. View Once /
self-destructing / expiring media was not implemented and none of those markers
appear anywhere in this change.
