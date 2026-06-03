# Livestream — Test Case Index

Module prefix: **`TC-LIVE-NNN`** · Status: **PARTIALLY IMPLEMENTED**

## Files

| File                                                 | Contents                                                                                         | Status                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| [`livestream-comments.md`](./livestream-comments.md) | Real, grounded cases for the livestream **comment** feature (service + repository + Mongo model) | IMPLEMENTED logic (transport not yet wired) |
| [`gaps-and-planned.md`](./gaps-and-planned.md)       | Backlog checklist of stream lifecycle, RTMP, HLS, viewers, reactions, moderation                 | **NOT IMPLEMENTED — placeholder**           |

## What is implemented today

- **`LivestreamComment`** model `chat_livestream_comments` — `livestream-comment.repository.ts` / `livestream-comment.service.ts` in chat-service.
  - `addComment` with per-`(livestreamId, sentBy, clientCommentId)` idempotency.
  - `getComments` with `id`-descending cursor pagination (`before`, `limit`).
- **`Livestream`** model (schema only, no repo/service).
- **`LiveStreamSettings`** in user-service (`defaultVideoQuality`) — exercised under `users/` settings, not here.

**Important:** the comment service/repository are **not wired** to any socket handler, controller, route, or gRPC method. No `room:livestream:*` events exist in `apps/api-gateway/src/sockets/`. Cases asserting transport/auth/rate-limit/broadcast are labeled `[transport pending]` — their underlying service/DB behavior is real and testable by calling the service directly.

## Test case inventory (`livestream-comments.md`)

| ID range         | Group                                | Count  |
| ---------------- | ------------------------------------ | ------ |
| TC-LIVE-001..003 | Happy Path                           | 3      |
| TC-LIVE-010..013 | Input Validation / Params            | 4      |
| TC-LIVE-020..022 | AuthN / AuthZ / Security             | 3      |
| TC-LIVE-030..033 | Business Rules (idempotency, status) | 4      |
| TC-LIVE-040..043 | Pagination / Edge                    | 4      |
| TC-LIVE-050..052 | Concurrency / Rate Limit             | 3      |
| TC-LIVE-060..062 | Security                             | 3      |
| TC-LIVE-070..072 | Realtime / Socket emission           | 3      |
| **Total**        |                                      | **27** |

Planned-but-missing cases reserved at **TC-LIVE-100..299** in `gaps-and-planned.md`.

## Planned but NOT implemented (summary)

1. **`stream-service`** itself (HTTP 3007 / gRPC 4007, MongoDB) — does not exist.
2. **Stream lifecycle** — create/schedule/start/stop/cancel; status transitions; `isLive` badge.
3. **RTMP ingest (OSSRS)** — stream keys, publish webhooks, credential hygiene.
4. **HLS playback** — `.m3u8` URLs, ABR quality, signed/expiring tokens, VOD.
5. **Viewer presence & counts** — join/leave counting, throttled broadcast, multi-instance accuracy.
6. **Reactions** — send/aggregate/fan-out, flood control.
7. **Comment moderation** — delete/pin/mute/ban/slow-mode/report/profanity filter/TTL (no delete method exists today).
8. **Notifications** — "went live" push gated by `liveStreamEnabled` + quiet hours.

Plus wiring-gap defects in the existing comment code (no transport, no validation, no auth-derived sender, no rate limit, non-atomic idempotency) — see end of `gaps-and-planned.md`.
