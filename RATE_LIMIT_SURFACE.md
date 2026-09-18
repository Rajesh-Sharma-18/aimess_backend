# Rate-limit surface

Every place that can produce a 429 / `RATE_LIMITED`, and every client handler
that reacts to one. Rule of the house: limits stay on for abuse, but a throttle
must never blank the app or block normal chat.

- **Reads** (history, inbox, join, catch-up, download-url): never shown as an
  empty state. Retried until the server's `Retry-After` passes. Fail open if
  Redis is down.
- **Send**: has its own bucket. The message shows optimistically and waits the
  server's `Retry-After` seconds.
- **`@all`**: the limit applies to the notification only. Over the limit, the
  message is still stored and delivered.
- **`@user`**: an ordinary send.
- **Media**: write and read have separate buckets.
- **One send limiter** covers REST and socket (gRPC `assertSendAllowed`).
- **Buckets are keyed on the verified `userId`**, not on the raw JWT.
  `RATE_LIMIT_ENABLED` stays `true`, and production refuses to boot with it off.

## Producers (backend)

### api-gateway (`apps/api-gateway/src/middleware/rate-limit.ts`, express-rate-limit + Redis store)

The key is `u:<verified sub>` (`credentialKey`). An unverifiable token gets a digest bucket, and a request with no token gets an IP bucket.
The Redis store fails open (`redis-rate-limit-store.ts`).

| Rule (Redis key `rl:gw:<rule>:`) | Scope | Default | Mounted on |
|---|---|---|---|
| `global.read` **(new)** | session | `GLOBAL_READ_RATE_LIMIT_MAX` 600/min | app-wide, GET/HEAD + `POST /api/v1/media/download-url` (`isReadTraffic`) |
| `global` (now writes only) | session | `GLOBAL_RATE_LIMIT_MAX` 300/min | app-wide, everything else |
| `read.generous` | session | `READ_RATE_LIMIT_MAX` 300/min | `/users/friends`, `/chat/conversations` |
| `media.read` **(new, split from read.generous)** | session | `MEDIA_READ_RATE_LIMIT_MAX` 600/min | `/media/download-url`, `/media/scan-status`, `/media/usage` |
| `media.upload-url` (media write) | session | `MEDIA_UPLOAD_RATE_LIMIT_MAX` 90/min | `/media/upload-url`, `/media/confirm`, `/media/uploads` |
| `search` | session | 60/min | `/users/search`, `/users/discovery`, `/communities/search`, `/chat/search`, `/search` |
| `stream` | session | 200/min | `/streams` (heartbeat/quality exempt) |
| `device.token-register` | session | 10/min | `/devices`, `/notifications/fcm-token` |
| `auth.sensitive` / `auth.login` / `auth.refresh` / `auth.otp` / `auth.account-validate` / `auth.forgot-password` | ip | env | auth paths (pre-auth, so IP is correct) |
| `community.invite-preview` | ip | 30/15min | invite previews |
| `admin.read` / `admin.write` / `admin.login` | admin/ip | env | backoffice |
| `srs.hooks` / `livekit.webhook` | ip | 3000/min | callbacks |

The 429 envelope is `error.code=RATE_LIMITED`, `error.retryAfter`, plus a `Retry-After` header (`makeHandler`).

### chat-service (`apps/chat-service/src/middleware/rate-limit.ts`, Redis sliding window)

Keyed on `req.auth.userId` (verified). Reads fail open. Writes fall back to an in-process counter.

| Bucket | Default | Where |
|---|---|---|
| `{pm,gm,cm}:send` | 300/min | REST `limits.send` + gRPC `assertSendAllowed` (socket), same key |
| `{pm,gm,cm}:read` | 240/min | read-position writes |
| `{pm,gm,cm}:interact` | 120/min | reactions, pins, edits |
| `{pm,gm,cm}:sensitive` | 30/min | reports, policy, room create |
| `inbox:list` | 120/min | `GET /inbox` |
| `sync:events` | 120/min | `GET /sync` |
| `gm:mention-all` | 5 per 10 min per (room, sender) | **notify-only now.** `mentionAllAllowed` returns a boolean and never throws |
| bulk / group-room create / sensitive | route-local | `conversation-bulk.routes.ts`, `group-room.routes.ts` |

History GETs (`/private|groups|community …/messages`) have **no** chat-service limiter. Only the gateway `global.read` bucket applies to them.

Over the limit, a gRPC `TooManyRequestsError` becomes `RESOURCE_EXHAUSTED` with **`retry-after` metadata (new)**. The gateway's `resolveGrpcAckError` then builds a `RATE_LIMITED` ack carrying `retryAfter` for `message:send` and `community:message:send`.

### Other services
- media-service: in-memory limiter keyed on userId. Covers upload and confirm (200/15min) and scan-status (1500/15min). download-url is exempt.
- auth-service: its own OTP, login, device-link and deletion limiters (pre-auth, IP or account).
- community-service: invite-link creation limiter.
- Socket `call:initiate`: a Redis counter that returns `RATE_LIMITED` with `retryAfter`. Room join, catch-up and typing are **not** limited.

## Client handlers (`aimess_website`)

| Where | Behaviour on 429 |
|---|---|
| `src/utils/retryPolicy.ts` `maxRetriesFor` | **new:** a 429 is retried up to `MAX_RATE_LIMIT_RETRIES` (6). Each wait is the `Retry-After` value (capped at 20s). Other transient errors keep the cap of 3 |
| `src/services/BaseService.ts` interceptor | automatic retry for idempotent requests or ones marked `_idempotent`. A 429 is toasted once, deduplicated |
| `src/providers/QueryProvider.tsx` | query retry uses the same `maxRetriesFor` |
| `src/controller/chat/chat.api.ts` `getMediaDownloadUrl` | **now `_idempotent`**, so a throttled download-url retries instead of failing |
| `useGroupTranscript` / `useDmTranscript` seed | **new:** a transient failure keeps the loader and re-seeds after the wait. It no longer sets `historyLoaded` on an empty list |
| `useCommunityChatTranscript` initial page | **new:** a transient error keeps `isLoadingInitial` and refetches after the wait |
| `MessageThreadsContext` inbox | **new:** a transient error with no data keeps `isLoadingThreads` and refetches |
| `src/services/outboxProcessor.ts` | **new:** a `RATE_LIMITED` ack with `retryAfter` waits that long plus jitter and does not count toward `MAX_OUTBOX_RETRIES`, so the message never gets a Retry badge |
| outbox / `useGroupTranscript` `CHAT_MENTION_ALL_RATE_LIMITED` | kept only for servers that predate this change. The server no longer emits it |
| `mediaUploadQueue.ts` | a global cooldown on 429 that honours `Retry-After` (unchanged) |
| `useChatMedia.resolveMediaDownloadUrl` | a failed URL is suppressed for 1 min and affects that tile only. It never touches the thread |
| `useSignupProof`, `QrCodeScanUsingApp`, `CallContext` | honour `retryAfter` (unchanged) |

The client's generic toast no longer fires for a GET/HEAD 429 (`BaseService.ts`). A read throttle is never shown as a red error.

## Plan scenarios 1–14 (`AIMESS_RATE_LIMIT_PLAN.md`)

| # | Scenario | Result | Covered by |
|---|---|---|---|
| 1 | Brand-new account, first login, Message tab | Pass. The inbox sits in `global.read` (600). A transient error keeps the loader and refetches, so there is no empty list | `read-write-split.test.ts`; `MessageThreadsContext` |
| 2 | First tap on a group, community or DM | Pass. History has no service limiter, and a seed that fails transiently keeps the loader and re-seeds | `read-write-split` "30x GET history"; the three transcript hooks |
| 3 | Cold start: inbox + avatars + unread + history | Pass. Reads never share a bucket with writes, and download-url has its own `media.read` 600 | `read-write-split` "download-url burst" |
| 4 | App and web in the same minute | Pass. Both land in the same `u:<id>` bucket, which has 600 reads | `credentialKey` |
| 5 | Duplicate GETs on a slow network | Pass. React Query deduplicates queries and a 429 retry waits `Retry-After` | `retryPolicy.spec.ts` |
| 6 | 429 on history | Pass. Skeleton plus retry, and `messages` is never committed empty | `useGroupTranscript`/`useDmTranscript` reseed, `useCommunityChatTranscript` refetch |
| 7 | 429 on inbox | Pass. The loader stays and it refetches. Cached rows are never wiped | `MessageThreadsContext` |
| 8 | Deep link `/message/:id` on a cold start | Pass. It uses the same seed path as #2 | (as #2) |
| 9 | Invited into a group, opened from the notification | Pass. It uses the same seed path as #2 | (as #2) |
| 10 | Kill and reopen, catch-up | Pass. Catch-up and join have no limiter, and REST sync reads get the 429 retry | `chat.ns.ts` (no limiter on join/catch-up) |
| 11 | `@all` 3–10 times in a group of 8 | Pass. Every message is stored and nothing fails with Retry; the notify pauses past 5 per 10 minutes | chat "10 @all sends over the limit → 10 stored" |
| 12 | "Wait a few minutes" toast | Pass. The server no longer emits `CHAT_MENTION_ALL_RATE_LIMITED` | chat "over the @all limit" |
| 13 | `@all` then a plain `hy` | Pass. `hy` uses the send bucket, which is separate from mention.all | `send-limit-shared` "never spends the send bucket" |
| 14 | `Hey @all` mixed with text | Pass. The body and any `@user` pushes are saved, and only the @all push is skipped | chat "over the @all limit → message still stored" |

The other checks from the plan: send flood (#54) 429s writes only; socket and REST share one send quota (#38); Redis down (#55) keeps reads working; login and OTP abuse (#51, #52) stay IP-limited. Their tests are `read-write-split`, `send-limit-shared`, `redis-store.test.ts`, and the auth limiter tests.
