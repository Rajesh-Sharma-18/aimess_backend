# Rate-limit decisions: old vs new

This is the companion to `RATE_LIMIT_SURFACE.md`. It measures the budgets
against `AIMESS_RATE_LIMIT_PLAN.md` Phase 4 and records where this repo keeps
a different number, and why.

| Bucket | Old | New | Plan | Decision |
|---|---|---|---|---|
| Gateway backstop | one `global` bucket for reads and writes, 200/min | `global` counts **writes only**, 300/min | ≥300 after the class split | Matches the plan. At 200 the backstop capped REST sends below chat-service's 300/min send bucket |
| read (gateway) | shared the 200 | `global.read` 600/min | 600/min, burst 80 | Matches the plan. It is a fixed window, so the burst is the whole 600 |
| read (chat-service history) | none | none | read | History GETs carry no service limiter. Only `global.read` applies |
| inbox / sync | 120/min each | unchanged | read | Kept. Each one is the heaviest fan-out query and still has 5× headroom over a cold start |
| media-read | shared `read.generous` 300 with conversation lists | `media.read` 600/min | 600/min | Matches the plan |
| media-write | 90/min | unchanged | 60/min | **Kept at 90.** Each item costs 2 requests (mint + confirm) and an album holds 10 items, so 60 would 429 the third album in a minute |
| send (`pm`/`gm`/`cm`) | 300/min sliding window | unchanged | 60/min, burst 10–15 | **Kept at 300.** Measured: at 60, a 100-message burst got 28 refusals and tripped the gRPC circuit breaker (see `messagingRateLimits`). A sliding window has no separate burst knob. 300 still caps an unattended loop at 5/s |
| mention.all | 5 per 10 min per (room, sender), and **rejected the send** | 5 per 10 min, **notify-only** | 5/min, notify-only | The behaviour now matches the plan: the message always persists. The window stays at 10 minutes because @all bypasses mute for the whole roster |
| `@user` | send bucket | send bucket | send | Unchanged, never charged to mention.all |
| auth login | 15 per 5 min (IP, failures only) | unchanged | 20 per 15 min (IP) | Kept. It counts only failures, so it is already looser for real users than the plan's number |
| Socket send vs REST | one gRPC `assertSendAllowed` key | same, and the ack now carries `retryAfter` | one counter | Matches the plan |
| Key | verified `sub` (`u:<id>`) | unchanged | verified userId | Matches the plan. A refresh never opens a new bucket |
| Redis down | gateway and chat reads fail open; chat writes fall back to an in-process counter | unchanged | reads open, writes fall back | Matches the plan |

Env fields changed: the `GLOBAL_RATE_LIMIT_MAX` default went from 200 to 300. `GLOBAL_READ_RATE_LIMIT_MAX` (600) and
`MEDIA_READ_RATE_LIMIT_MAX` (600) are new.
