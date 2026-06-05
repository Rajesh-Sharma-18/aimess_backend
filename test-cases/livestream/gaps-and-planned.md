# Livestream — Gaps & Planned (NOT IMPLEMENTED)

> **Status: NOT IMPLEMENTED — placeholder.**
>
> Everything in this file describes livestream capabilities that are **planned but absent** from the
> current codebase. There is **no `stream-service`** (target HTTP `3007` / gRPC `4007`, MongoDB) — the
> directory does not exist under `apps/`. No RTMP ingest, no HLS playback, no viewer presence/counts,
> no reactions, and no stream lifecycle endpoints are wired anywhere.
>
> **What actually exists today (for contrast):**
>
> - chat-service: `Livestream` Mongo model (schema only — `roomId, title, description, thumbnail, scheduledAt, status[SCHEDULED|LIVE|ENDED|CANCELED], livedAt, tags, servers`) with **no** repository/service/route.
> - chat-service: `LivestreamComment` model + repository + service (see `livestream-comments.md`) — but **not wired** to any transport.
> - user-service: `LiveStreamSettings` (`defaultVideoQuality`: `AUTO|HIGH_1080P|STANDARD_720P|DATA_SAVER_480P`) — wired via settings API; covered under `users/` settings cases, not here.
> - user-service: `liveStreamEnabled` notification toggle.
> - Infra references only (no code): `docs/reviewer.md` mentions "RTMP stream keys / TURN credentials never logged" and a sharded `streams` collection; the `aimess-architecture` skill notes OSSRS for livestream. These are design intent, not implementation.
>
> The checklist below is the backlog of test cases to author **once each capability is built**. Do
> not treat these as runnable today. ID range reserved: **TC-LIVE-100 … TC-LIVE-299**.

---

## A. Stream lifecycle (create / schedule / start / stop / cancel) — NOT IMPLEMENTED

The `Livestream` model exists but nothing reads/writes it. Needs repository + service + transport.

- [ ] **TC-LIVE-100** Create a scheduled livestream (`status=SCHEDULED`, `scheduledAt` set) — happy path, DB row.
- [ ] **TC-LIVE-101** Create requires a valid `roomId` belonging to a community the caller can broadcast in (AuthZ).
- [ ] **TC-LIVE-102** Title required / length validation; tags array validation.
- [ ] **TC-LIVE-103** Start a stream: transition `SCHEDULED → LIVE`, set `livedAt`, allocate `servers` (OSSRS edge list).
- [ ] **TC-LIVE-104** Stop a stream: transition `LIVE → ENDED`; reject comments afterward (links TC-LIVE-033).
- [ ] **TC-LIVE-105** Cancel a scheduled stream: `SCHEDULED → CANCELED`; cannot later be started.
- [ ] **TC-LIVE-106** Illegal transitions rejected (`ENDED → LIVE`, `CANCELED → LIVE`) — Business Rule.
- [ ] **TC-LIVE-107** Only the stream owner / community moderator can start/stop/cancel — AuthZ/RBAC.
- [ ] **TC-LIVE-108** Concurrency: two start requests race — exactly one transition wins.
- [ ] **TC-LIVE-109** `chat:room:joined` exposes `isLive: true` badge when a stream is LIVE (see `docs/chat-socket-backend-spec.md` line ~1365).
- [ ] **TC-LIVE-110** Sharded `streams` collection queried with shard key (no scatter-gather) — per `docs/optimiser.md`.

## B. RTMP ingest (OSSRS) — NOT IMPLEMENTED

- [ ] **TC-LIVE-120** Issue a per-stream RTMP ingest URL + secret stream key on start.
- [ ] **TC-LIVE-121** Stream key is single-use / scoped to one stream; rotated on restart.
- [ ] **TC-LIVE-122** OSSRS publish webhook authenticates the stream key before allowing ingest — Security.
- [ ] **TC-LIVE-123** OSSRS on_publish / on_unpublish callbacks flip `status` LIVE/ENDED.
- [ ] **TC-LIVE-124** Stream keys / credentials never logged (only hashes) — per `docs/reviewer.md` line 63. Security.
- [ ] **TC-LIVE-125** Reject ingest for a CANCELED/ENDED stream.
- [ ] **TC-LIVE-126** Unauthorized publisher (wrong/forged key) is refused — AuthN.

## C. HLS playback — NOT IMPLEMENTED

- [ ] **TC-LIVE-140** Viewer receives an HLS (`.m3u8`) playback URL for a LIVE stream.
- [ ] **TC-LIVE-141** Playback URL respects `defaultVideoQuality` / ABR variants.
- [ ] **TC-LIVE-142** Playback denied for non-members of a private community stream — AuthZ.
- [ ] **TC-LIVE-143** Playback URL invalid/expired once stream is ENDED.
- [ ] **TC-LIVE-144** Signed/expiring playback tokens — Security.
- [ ] **TC-LIVE-145** VOD/replay availability after ENDED (if in scope).

## D. Viewer presence & counts — NOT IMPLEMENTED

- [ ] **TC-LIVE-160** Joining a livestream increments the live viewer count; leaving decrements.
- [ ] **TC-LIVE-161** Viewer count broadcast (`room:livestream:viewers`) throttled/debounced under churn.
- [ ] **TC-LIVE-162** Disconnect (socket drop) decrements the count (no ghost viewers) — uses presence/heartbeat.
- [ ] **TC-LIVE-163** Concurrency: 10k simultaneous joins produce an accurate (eventually-consistent) count.
- [ ] **TC-LIVE-164** Count accurate across multiple gateway instances (Redis adapter / Redis counter).
- [ ] **TC-LIVE-165** Peak-viewer high-water mark persisted on the stream.

## E. Reactions — NOT IMPLEMENTED

- [ ] **TC-LIVE-180** Send a reaction (❤️ / 👍 etc.) to a LIVE stream.
- [ ] **TC-LIVE-181** Reaction flood rate-limited per viewer.
- [ ] **TC-LIVE-182** Reactions aggregated/batched before broadcast (no per-reaction fan-out storm).
- [ ] **TC-LIVE-183** Reactions rejected for non-LIVE streams.
- [ ] **TC-LIVE-184** Reaction event fan-out via Redis adapter to all viewers.

## F. Comment moderation — NOT IMPLEMENTED (comments exist; moderation does not)

- [ ] **TC-LIVE-200** Delete a livestream comment (soft or hard) — owner or moderator. _(No delete method exists on `LivestreamCommentRepository` today.)_
- [ ] **TC-LIVE-201** Moderator can delete another viewer's comment; viewer can only delete own — RBAC.
- [ ] **TC-LIVE-202** Deleting broadcasts `room:livestream:comment:deleted` to the room.
- [ ] **TC-LIVE-203** Pin/highlight a comment (host) — if in scope.
- [ ] **TC-LIVE-204** Mute/ban a viewer from commenting on a stream; their further comments rejected.
- [ ] **TC-LIVE-205** Profanity / spam filtering on comment text (server-side) — currently none.
- [ ] **TC-LIVE-206** Slow-mode (per-stream minimum interval between a viewer's comments).
- [ ] **TC-LIVE-207** Report a livestream comment.
- [ ] **TC-LIVE-208** Comment TTL / auto-delete per livestream-chat TTL spec (`docs/reviewer.md` line 86) — TTL index.

## G. Notifications & misc — NOT IMPLEMENTED

- [ ] **TC-LIVE-220** "Stream went live" push notification respects the `liveStreamEnabled` toggle (user-service).
- [ ] **TC-LIVE-221** Notification suppressed during the recipient's quiet hours.
- [ ] **TC-LIVE-222** Followers/members of the community notified on stream start.

---

### Wiring gaps in the _already-written_ comment code (defects to fix before GA)

These are not new features but missing guards in shipped comment code — tracked in `livestream-comments.md`:

- [ ] No transport (socket handler / gRPC method) calls `LivestreamCommentService` — feature is dead code until wired.
- [ ] No empty/whitespace message validation (TC-LIVE-010).
- [ ] No message length cap (TC-LIVE-011).
- [ ] `userId` / sender fields trusted from caller instead of auth context (TC-LIVE-021).
- [ ] No room-membership / stream-status authorization (TC-LIVE-022, TC-LIVE-033).
- [ ] No `limit` clamp on pagination (TC-LIVE-041).
- [ ] No rate limiting (TC-LIVE-050).
- [ ] Idempotency is read-then-write with **no unique index** → race can duplicate (TC-LIVE-052).
