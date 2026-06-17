# AIMess Centralized Media Management — Architecture & Implementation

**Date:** 2026-06-16 · **Scope:** ownership tracking, resource classification, secure downloads, lifecycle, analytics across all media surfaces · **Companion to** [`MEDIA_ARCHITECTURE_REVIEW.md`](./MEDIA_ARCHITECTURE_REVIEW.md) (which covers the content-type / format / scanning dimension).

> **One upload API, always.** This design adds a classification + ownership + authorization layer **on top of** the single centralized `/api/v1/media/upload-url` endpoint. It never reintroduces per-feature upload APIs. Every uploaded object becomes a tracked, owned, classified, lifecycle-managed record.

---

## 1. Current architecture review (verified against on-disk code, 2026-06-16)

The platform already has a **correct two-plane media spine**:

- **Control plane — `media-service` (HTTP 3009 / gRPC 4009).** Mints presigned PUT/GET URLs over REST (`/api/v1/media/upload-url`, `/confirm`, `/download-url`, `GET /scan-status`, `DELETE /uploads/:objectKey`) and gRPC. Never touches file bytes. Gateway-proxies `/api/v1/media/*` → media-service (env-gated on `MEDIA_SERVICE_URL`).
- **Data plane — client ↔ MinIO directly.** Bytes PUT/GET straight to storage. App tier carries zero media bytes → correct for millions of files.
- **Single shared contract.** `MediaObject` (`@aimess/shared-types`), `toMediaObject()`/`createMediaUrlStrategy()` (`@aimess/storage`), 3 logical buckets (`avatars`, `community`, `chat`) routed by key prefix.
- **Resolve-on-read everywhere.** Raw object keys persisted in every DB; a fresh presigned/CDN URL is generated on every read (REST/gRPC/socket/push). Never persist a resolved URL.
- **Security pipeline (now committed, was uncommitted WIP).** Magic-byte validation, OOXML structure check, ZIP-bomb / nested-archive / entry-count inspection, ClamAV (INSTREAM/TCP) async via a Bull queue, Redis scan-status gate, Telegram-parity MIME set + per-MIME caps + forced-download for non-media.

**Object key format:** `{prefix}/{ownerId}/{fileId}.{ext}` — e.g. `chat-uploads/<uploaderUUID>/<uuid>.pdf`.

## 2. Problems found (ranked, with file:line evidence)

| #      | Severity | Problem                                                                                                                                                                                                                                                         | Evidence                                                                |
| ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **P1** | 🔴 HIGH  | **Community/group attachment download has no membership check** — only `objectKey.startsWith(prefix)`. Any authenticated user can download any community/group attachment given the key (IDOR).                                                                 | `media.service.ts:285-292`                                              |
| **P2** | 🔴 HIGH  | **Private-chat authz inconsistent**: `/download-url` is uploader-only (blocks the legitimate recipient), while chat-service resolve-on-read presigns by key with **no** participant check. Same object: over-restricted on one path, unrestricted on the other. | `media.service.ts:276-284` vs `chat-service/.../media-resolve.ts:49-63` |
| **P3** | 🟢 FIXED | Download gate failed open: blocked only PENDING/INFECTED/QUARANTINED, fell through for `ERROR`/unknown. **Fixed** → allow-list (only CLEAN/SKIPPED served).                                                                                                     | commit `92dc189`                                                        |
| **P4** | 🟠 OPEN  | **No media DB model** → no ownership ledger, quota, access log, orphan cleanup, analytics. Scan verdicts lived only in Redis (7-day TTL). **Foundation built** (MediaFile registry, `media_db`); wiring pending.                                                | commit `a2f1633`                                                        |
| **P5** | 🟢 FIXED | Entire security pipeline was uncommitted/untracked → at risk of the working-tree churn anomaly. **Preserved** by committing.                                                                                                                                    | commit `6174b1f`                                                        |
| P6     | 🟠 OPEN  | `MEDIA_UPLOAD.md` documents chat-rooted routes (`/api/chat/media/*`) contradicting the centralized `/api/v1/media`; size cap not enforced by MinIO (Content-Length not signed); CDN strategy inconsistent across services.                                      | doc + `presign.ts:14-30`                                                |

## 3. Recommended architecture

A **MediaFile registry** is the keystone: one durable record per uploaded object, created at confirm time, binding the immutable storage key to **who owns it, what resource it belongs to, its scan verdict, and its lifecycle**. This is what makes correct authorization possible — a chat attachment's key encodes the _uploader_ but **not** which room/community it lives in, so without the registry, media-service literally cannot know whose membership to check on download.

```
upload-url ──► client PUTs to MinIO ──► confirm ──► [register MediaFile] ──► scan ──► CLEAN
                                                          │
download-url ──► [read MediaFile] ──► resource policy ──► membership gRPC ──► presign ──► [access log]
```

## 4. Database changes (decision: media-service owns a new Mongo `media_db`)

`media-service` had no datastore. Per the bounded-context rule (the service that mints keys & scans should own the records) and the Mongo-for-high-volume pattern (chat/community), the registry lives in a **new Mongo `media_db`** via Prisma (mirrors chat-service's proven setup).

**`MediaFile`** (built — `apps/media-service/prisma/schema.prisma`): `objectKey` (unique), `bucket`, `uploadCategory`, `ownerType`, `resourceType`, `ownerId`, `resourceId?`, `fileName?`, `contentType`, `size?`, `fileHash?`, `scanStatus`, `scanDetail?`, `scannedAt?`, `usageStatus`, `unusedAt?`, `deletedAt?`, `createdAt`, `updatedAt`. Indexes: `[ownerId,resourceType]`, `[resourceId,resourceType]`, `[scanStatus]`, `[usageStatus,unusedAt]`, `[createdAt]`.

**Future collections** (designed, not built): `MediaAccessLog` (audit: who/when/action/result), `UserMediaQuota` (per-user bytes/quota snapshot), `MediaAnalytics` (daily aggregates). Mongo is schemaless → adding these and new `MediaFile` fields needs **no migration**.

## 5. Storage strategy

Keep the current `{prefix}/{ownerId}/{fileId}.{ext}` keys and resolve-on-read (the only correct model with expiring URLs). The registry's `resourceId` supplies the room/community binding the key omits, so the key format need **not** change. Future: per-bucket CDN cutover for public assets (avatars/community branding), `quarantine` bucket, lifecycle expiry for orphaned uploads, multipart for large video.

## 6. Security improvements

**Done:** magic-byte validation, OOXML check, ZIP-bomb/nested/entry-count inspection, ClamAV async scan, scan-status gate **inverted to an allow-list** (P3 — only CLEAN/SKIPPED served; ERROR/unknown blocked), forced-download for non-media, filename sanitization, extension↔MIME check, confirm returns a uniform verdict.

**Next:** resource-driven download authorization (P1/P2, §8), durable scan verdicts in the registry (survives Redis TTL), per-user upload quota, post-upload HEAD size re-check (MinIO doesn't enforce the declared Content-Length).

## 7. Media classification model (built — `@aimess/constants` `media/classification.ts`)

House idiom: `as const` tuples + derived unions (not the TS `enum` keyword), dependency-free, `z.enum`-wrappable.

- **`MediaOwnerType`** — `USER, COMMUNITY, GROUP, PRIVATE_CHAT, COMMUNITY_CHAT, GROUP_CHAT, LIVESTREAM, SYSTEM, ADMIN`.
- **`MediaResourceType`** — `USER_AVATAR/COVER, COMMUNITY_AVATAR/BANNER, GROUP_AVATAR, {PRIVATE,GROUP,COMMUNITY}_CHAT_{IMAGE,VIDEO,AUDIO,DOCUMENT}, LIVESTREAM_{THUMBNAIL,BANNER,RECORDING}, ADMIN_ATTACHMENT, OTHER`. Chat attachments split by media kind for analytics/retention; derived from upload category + MIME at confirm.
- **`MediaScanStatus`** — `PENDING, SCANNING, CLEAN, REJECTED, INFECTED, QUARANTINED, SKIPPED, ERROR` (adds first-class `REJECTED` = structural reject ≠ virus). `DOWNLOADABLE_SCAN_STATUSES = [CLEAN, SKIPPED]`.
- **`MediaUsageStatus`** — `ACTIVE, UNUSED, DELETED` (lifecycle).
- **`MediaAccessPolicy`** + `RESOURCE_OWNER_TYPE` + `RESOURCE_ACCESS_POLICY` maps — the authorization matrix (§8).

## 8. Authorization model (resource-type driven)

Each `MediaResourceType` maps to one `MediaAccessPolicy` (`RESOURCE_ACCESS_POLICY`):

| Policy                     | Resource types                                                          | Check on `/download-url`       |
| -------------------------- | ----------------------------------------------------------------------- | ------------------------------ |
| `PUBLIC`                   | USER_AVATAR/COVER, COMMUNITY_AVATAR/BANNER, LIVESTREAM_THUMBNAIL/BANNER | any authenticated user         |
| `PRIVATE_CHAT_PARTICIPANT` | PRIVATE*CHAT*\*                                                         | either participant of the room |
| `GROUP_MEMBER`             | GROUP*AVATAR, GROUP_CHAT*\*                                             | a member of the group          |
| `COMMUNITY_MEMBER`         | COMMUNITY*CHAT*\*, LIVESTREAM_RECORDING                                 | a member of the community      |
| `ADMIN`                    | ADMIN_ATTACHMENT                                                        | backoffice/moderation role     |
| `OWNER`                    | OTHER                                                                   | uploader only                  |

**Enforcement (planned):** `download-url` reads the `MediaFile` → `resourceType` → policy + `resourceId` → for non-PUBLIC chat policies, a **gRPC call to chat-service** (`CheckMediaAccess`, reusing its existing `assertPrivateParticipant`/`assertGroupMember`/`assertCommunityMember` guards), wrapped in an opossum circuit breaker. This closes P1 (membership now verified) and P2 (recipient allowed; consistent across paths) — and because `resourceId` comes from the registry, not the client, it is **not** spoofable.

> The inline resolve-on-read path (chat-service presigning attachments during message delivery) authorizes at the message-delivery layer (you received the message ⇒ you may see its attachments) and intentionally does not re-run per-file checks — that would kill batch presign performance. The explicit `/download-url` endpoint is where these policies are enforced.

## 9. Migration plan

Mongo `media_db` is new and empty — **no schema migration**. Existing MinIO objects predate the registry. A one-time **backfill** lists each bucket and `register()`s a `MediaFile` per object: infer `uploadCategory`/`resourceType`/`ownerType` from the key prefix, `ownerId` from the key's owner segment, `scanStatus="SKIPPED"` (legacy = assumed safe), `usageStatus="ACTIVE"`. Idempotent (upsert on `objectKey`). Until backfilled, download authz falls back to the current prefix/owner checks for keys with no registry row (documented interim).

## 10. Implementation plan & status

**Shipped this session (4 commits on `rajesh-dev`):**

1. `6174b1f` — preserved the entire (uncommitted, churn-at-risk) security pipeline: ClamAV scanner, confirm/scan-status, magic-validator, zip-inspector, MEDIA_MESSAGES, ClamAV docker service, +4 tests.
2. `92dc189` — **P3** fail-open fix (download gate → allow-list).
3. `ceb4c46` — **classification enums** (`MediaOwnerType`/`MediaResourceType`/`MediaScanStatus`/`MediaAccessPolicy` + owner/policy maps).
4. `a2f1633` — **MediaFile registry foundation** (`media_db` schema + prisma config + repository, typed against the enums) + `MEDIA_USAGE_STATUSES` + confirm-contract fix. Typecheck green, suite 61/61.

**Remaining (sequenced):**

1. **Wire confirm → register** — add `resolveResourceType(category, mime)`; `confirmUpload` (and best-effort `upload-url`) call `mediaFileRepository.register()` with `ownerType`/`resourceType`/`resourceId`; accept optional `resourceId` in the validator/controller; persist scan verdict to the registry too. Add a prisma/repository mock to `tests/setup/global-mocks.ts`.
2. **Resource-driven download authz (P1/P2)** — `generateDownloadUrl`/`getScanStatus` read the `MediaFile`, resolve policy, and for chat policies call chat-service `CheckMediaAccess` over gRPC (opossum). Add the proto method + chat-service handler (reusing `access-guard.ts`) + media-service gRPC client.
3. **Lifecycle/cleanup (Phase 12)** — RabbitMQ consumers mark `UNUSED` on message/community/user delete; nightly Bull job hard-deletes `UNUSED` past a 30-day grace and sets `DELETED`.
4. **Analytics (Phase 13)** — daily aggregation job → `MediaAnalytics`; `UserMediaQuota` snapshots; admin queries.
5. **Backfill (Phase 14)** — one-time registry backfill from MinIO (§9).
6. **Contracts/docs** — `MediaAccessLog`; reconcile `MEDIA_UPLOAD.md` routes; AsyncAPI/Swagger sync; per-bucket CDN cutover.

Each remaining phase runs through the review team (Pro Coder → DRY + Contract reviewers → Quality Tester) per `CLAUDE.md`.
