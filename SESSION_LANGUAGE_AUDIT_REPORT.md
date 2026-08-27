# Session Language Audit — one object, one language

**Date:** 2026-08-26 · **Branch:** `rajesh-dev` · **Baseline commit:** `ace075b7`

Reported: a single notification object carried two languages — a Vietnamese envelope
(`title` / `body`) above an English payload (`payload.title` / `payload.body`) — on a session
whose language was English.

---

## 1. Root cause

Neither half was malfunctioning. **Both were correct answers to two different questions**,
resolved at two different times by two different pieces of code.

### 1.1 The two resolutions

**Write time — the payload.** `pushToUser` resolves the recipient's **account** language and
writes the inbox row under it:

```ts
// apps/notifications-service/src/services/push.service.ts:427
const locale = await getUserLocale(userId).catch(() => DEFAULT_LOCALE); // AppSettings.language
const rendered = input.copy?.(locale);
…
await runWithLocale(locale, () => chatNotificationClient.createNotification({ title, body, … }));
```

chat-service then publishes the realtime frame from that row:

```ts
// apps/chat-service/src/grpc/service-impl.ts:4365 — inside publishRow
const dto = await serializeNotification(row, req.userId as string);
//                                                            ^ no locale argument
```

`serializeNotification`'s `locale` parameter defaults to `currentLocale()`, which the
`runWithLocale` above has set to the **account** locale. That render produces `payload.title`
and `payload.body`.

**Delivery time — the envelope.** The gateway re-renders per receiving socket from the replay
ticket:

```ts
// apps/api-gateway/src/sockets/localize-notification.ts (before)
return {
  ...frame,
  ...(copy?.title && headingIsCopy ? { title: copy.title } : {}),
  ...(copy?.body ? { body: copy.body } : {}),
  …
};   // ← `frame.payload` is never touched
```

So the envelope followed `socket.data.locale` and the payload kept the account language.

### 1.2 Why the repro showed exactly `vi` over `en`

- Account (`AppSettings.language`) = **en** → `payload` in English. ✅ correct for what it is.
- Socket locale = **vi** → envelope in Vietnamese.

The socket was `vi` because, before commit `ace075b7`, a client that declared no language in
its handshake fell through to `DEFAULT_LOCALE`, which is `"vi"` in production. That half is
already fixed — the handshake now consults the account language before the server default —
so on this build the two sides would have *agreed by luck*.

**Agreeing by luck is not the fix.** Two devices of one account in two languages still get one
shared `payload`, and directive 1 requires the object to be internally consistent by
construction. The structural defect — two independent resolutions for one object — is what this
change removes.

### 1.3 Evidence

Baseline test run against `ace075b7`, driving `localizeNotificationFrame` with account `en` and
socket `vi`:

```
● BASELINE: nested payload must follow the socket locale
  Expected: "Phát hiện đăng nhập"
  Received: "Login Detected"
```

That is the reported object, reproduced from the two locales alone.

---

## 2. Open questions — answers used

| # | Question | Decision | Basis |
|---|---|---|---|
| 1 | Confirm the repro's session language | **English; the envelope was the wrong half** — but the payload was only right *by coincidence*: it is the ACCOUNT language, which happened to be English too. Had the account been Thai, both halves would have been wrong in different ways. | §1.2 |
| 2 | Push language source | **`DeviceToken.locale`**, written by the owning client at registration. It existed but was never refreshed after registration — closed here by a `locale:set` → `session:locale` → device-token update path (§4.3). | `schema.prisma:47`, §4.3 |
| 3 | Scope of "etc." | Channels found: in-app REST list, socket frames, FCM/APNs push, **email** (OTP / password reset). Email is out of scope by design — it is sent when no session exists, and already takes the request's `x-lang` at publish time (`publish-auth-email-otp.ts`). No SMS or webhooks exist. | repo sweep |
| 4 | History re-localization | **Yes** — falls out of the replay ticket; REST re-renders per read, socket per delivery. | §4.1 |
| 5 | Supported languages | `en`, `vi`, `th`. Fallback = `DEFAULT_LOCALE` (`vi` prod / `en` dev). An unknown *key* falls back to the producer's baked sentence, never a raw key. | `packages/constants/src/locale.ts` |
| 6 | Data hygiene on `type` | **Clean.** `type` is the frozen constant `AuthEvents.SECURITY_NEW_LOGIN = "auth.security_new_login"`, published verbatim and never string-built. The bracket artifact in the pasted JSON is a paste-rendering artifact, not stored data. Nothing to repair. | `packages/shared-types/src/events/auth.ts:6` |

---

## 3. Language Flow Map v2

### 3.1 Before

```
producer (consumer)          → copy thunk, locale UNBOUND
  └─ pushToUser
       ├─ locale := getUserLocale(userId)        ── ACCOUNT ────┐
       ├─ inbox row: title/body rendered at that locale         │  resolution #1
       │    + data.copyRef  (the replay ticket)                 │
       │                                                        │
       ├─ chat-service publishRow                               │
       │    serializeNotification(row)  ← currentLocale()  ─────┘
       │      ⇒ frame.title/body  AND  frame.payload.title/body
       │
       └─ device fan-out: viewFor(DeviceToken.locale)  ── PER DEVICE ✅

gateway /notify relay
  └─ localizeNotificationFrame(frame, socket.data.locale)  ── PER SOCKET ──┐  resolution #2
       ⇒ rewrites frame.title/body ONLY                                     │
       ⇒ frame.payload.* left at the ACCOUNT language  ←────────────────────┘  MISMATCH
```

### 3.2 After

```
gateway /notify relay
  └─ localizeNotificationFrame(frame, socket.data.locale)
       ⇒ ONE render of the ticket feeds BOTH halves,
         under the SAME heading rule                        ⇒ mismatch impossible

chat-service REST serializeNotification(row, viewer, locale = currentLocale())
       ⇒ ONE localizeRow feeds envelope AND payload
       ⇒ the stale-actor-name refresh now reaches both too   (§4.2)

notification:updated  (both publishers)
       ⇒ forwards the row's copyRef/dataRef, so the gateway can render it
         instead of passing account-language text through   (§4.4)

locale:set on any socket
       → publish session:locale {userId, sessionId, locale}
       → notifications-service updates DeviceToken.locale for THAT session
       ⇒ the push tray follows the language the session is actually reading in (§4.3)
```

---

## 4. Code changes

### 4.1 `localizeNotificationFrame` — one render, both halves

`apps/api-gateway/src/sockets/localize-notification.ts`

The `copy` already computed for the envelope is now written into the nested `payload.title` /
`payload.body` as well, **under the same `headingIsCopy` rule**. That last part matters: the
envelope heading is deliberately left alone when the row's heading is a *name*
(`data.inboxTitle` — the caller, the community) rather than product copy. Replacing the payload
title unconditionally would have swapped one divergence for another, so both halves are gated
on the same decision. `payload.data` is untouched — it carries ids and codes.

### 4.2 The REST half — the stale-name refresh reached only the envelope

`apps/chat-service/src/lib/notification-serializer.ts`

The locale replay was already consistent on REST (both halves derive from one `localizeRow`
call). But the serializer performs a *second* rewrite — replacing a stale/placeholder actor
name with a freshly-resolved one — and that one was applied to the envelope body only:

```ts
const effectivePayload = stripInternalDirectives(scrubbed?.payload ?? payloadObj);   // no refresh
const storedBody       = scrubbed?.body ?? refreshName(payloadObj.body) ?? "";       // refreshed
```

A card could therefore read "Mohit accepted your request" above a payload still saying
"Someone accepted your request". The deleted-actor scrub already returned a matching pair for
exactly this reason; the refresh now does too. Same defect class as the reported one — one
object, two renderings, only one rewritten.

### 4.3 Push language follows the session that owns the device

`packages/redis/src/session-locale.ts` (new) · `apps/api-gateway/src/sockets/locale-scope.ts` ·
`apps/notifications-service/src/consumers/session-locale.consumer.ts` (new) ·
`device-token.repository.ts`

`DeviceToken.locale` was written at registration and never again, so a user who changed
language in the app flipped every socket surface instantly and kept receiving push tray text in
the old language until the client happened to re-register its token — a contract the server
cannot enforce, and a mismatch visible on one device at one time (the banner says one language,
the notification it opens says another).

`locale:set` is the one moment the server genuinely knows. The gateway now publishes
`{userId, sessionId, locale}` on the `session:locale` channel; notifications-service subscribes
and updates `DeviceToken.locale` for **that session only** (`updateLocaleBySession`), so a
second device of the same account is never moved.

Fail-soft throughout: the publish is fire-and-forget (a language preference must not be able to
fail the packet that expressed it), the consumer re-validates the locale off the wire rather
than trusting it, and an unsupported value leaves the previous one in place rather than
normalizing onto the default.

### 4.4 `notification:updated` — the two publishers that dropped the ticket

`apps/chat-service/src/services/notification.service.ts` ·
`apps/chat-service/src/grpc/service-impl.ts`

Both rebuilt the frame's `data` from scratch (`{ actionTaken, sessionId }`), which discarded
`copyRef`/`dataRef`. The gateway localizes a `/notify` frame **only** when it can find a
ticket — so a resolved login alert was the one notification event that reached every session in
the account's language, whatever language that session was reading in, and no refetch could fix
the card already on screen.

Both now forward the row's tickets through one shared helper, `copyTickets`, added next to
`COPY_REF_KEY` in `@aimess/constants` rather than written twice (directive F4).

This is the same notification type as the repro, on the path that fires when the user taps a
button on that very card.

---

## 5. Audit table — type × field × channel × language source

`copy?` = the producer passes a localized builder (so a `copyRef` ticket is written).

| Producer / type | copy? | REST envelope | REST payload | Socket envelope | Socket payload | Push tray |
|---|---|---|---|---|---|---|
| `auth.security_new_login` | ✅ | reader | reader | socket | ~~account~~ → **socket** | device |
| `auth.password_changed` / `auth.email_changed` | ✅ | reader | reader | socket | ~~account~~ → **socket** | device |
| `admin.user_banned` / `_suspended` / `_unbanned` | ✅ (`ace075b7`) | reader | reader | socket | ~~account~~ → **socket** | device |
| `CALL_INCOMING` / `CALL_MISSED` / `call.activity` | ✅ | reader | reader | socket | ~~account~~ → **socket** | device |
| `CALL_CANCELLED` / `CALL_HANDLED` | N/A — `title`/`body` are `""`, data-only signals | — | — | — | — | — |
| friend: requested / accepted×2 / rejected×2 / cancelled | ✅ | reader | reader | socket | ~~account~~ → **socket** | device |
| community: 21 builders (join, invite, member, role, mute, ban, report, stream, lifecycle) | ✅ | reader | reader | socket | ~~account~~ → **socket** | device |
| group: memberAdded / memberMuted / memberUnmuted | ✅ | reader | reader | socket | ~~account~~ → **socket** | device |
| chat: message | ✅ | reader | reader | socket | ~~account~~ → **socket** | device |
| `resolution` line (`dataRef`) | ✅ | reader | reader | socket | socket | — |
| `system.announcement` | N/A — admin-**authored** content, never re-rendered | verbatim | verbatim | verbatim | verbatim | verbatim |
| `MESSAGE_READ` | N/A — `dataOnly`, no user-visible text | — | — | — | — | — |
| `notification:updated` (2 publishers) | ✅ | — | — | ~~account~~ → **socket** | — | — |
| `notification:deleted` / `:count_update` | N/A — counts and ids only | — | — | — | — | — |
| OTP / password-reset email | N/A — no session exists; uses the request's `x-lang` at publish | — | — | — | — | — |

`reader` = the REST caller's `x-lang`; `socket` = that connection's `socket.data.locale`;
`device` = `DeviceToken.locale`, falling back to the account language.

**49 registered copy builders**, every one carrying a descriptor — verified by enumerating the
registry, not by a hand-written list (§6, F1).

---

## 6. New tests

`apps/api-gateway/tests/sockets/notification-envelope-payload-locale.test.ts` (54 tests)
- **The repro**: account `en` + socket `vi` → envelope *and* payload Vietnamese; and the mirror
  case (account `vi`, socket `en`).
- Interpolated device/location kept verbatim in all three languages (A4/B4).
- Non-text fields untouched: `notificationId`, `type`, `data.actionType`, `payload.data` (A4).
- **F1 — the whole registry**: every builder in every exported namespace, rendered across
  3 stored × 3 session languages, asserting `payload.title === title` and
  `payload.body === body` *always*. Builders are enumerated from the namespaces, so a new
  notification type is covered the day it is added, not the day someone extends a list. Includes
  a guard that the sweep is non-empty and that every descriptor's `ref` matches its own name.
- The `dataRef` resolution line renders per socket too.
- **F3**: authored rows (no ticket) pass through by reference; an orphaned ticket keeps the
  stored sentence and never shows the ref; a malformed ticket does not throw; a frame with no
  `payload` does not grow one.

`apps/chat-service/tests/notifications/notification-envelope-payload.test.ts` (8 tests)
- The repro served over REST, in all three languages, envelope and payload.
- The replay ticket never reaches the wire (`stripInternalDirectives`).
- The stale-actor-name refresh lands on both halves, in every language, and leaves an
  already-named row alone.

`apps/notifications-service/tests/lib/session-locale-refresh.test.ts` (3 tests)
- The device-locale write is scoped to `(userId, sessionId)` — never to the user alone, so a
  second device cannot be moved.

`apps/api-gateway/tests/sockets/handshake-locale.test.ts` (+5 tests)
- `locale:set` publishes `session:locale` with the right shape; says nothing for an unsupported
  language or a socket with no session; still moves the socket with no publisher wired; a failed
  publish never breaks the packet or the ack.

---

## 7. Scenario matrix

**U** = unit/integration test here · **C** = code path verified by reading the single call site ·
**P** = pre-existing suite.

### A. The core bug

| ID | Status | Evidence |
|---|---|---|
| A1 | **PASS** | U repro test, English session, all fields English |
| A2 | **PASS** | U same across `vi` and `th`, both channels |
| A3 | **PASS** | U registry sweep — 49 builders, every one with a complete descriptor |
| A4 | **PASS** | U "leaves every non-text field alone" |
| A5 | **PASS** | U REST suite + gateway suite assert the same invariant on the same row shape |

### B. All notification types

| ID | Status | Evidence |
|---|---|---|
| B1 | **PASS** | U F1 sweep: every registered builder × 3 stored × 3 session languages |
| B2 | **PASS** | U auth (`newLogin`, `passwordChanged`, `emailChanged`) + account (ban/suspend/reinstate) in the sweep; `notification:updated` fixed (§4.4) |
| B3 | **PASS** | U friend (6), community (21), group (3), call (4), chat (1) all in the sweep |
| B4 | **PASS** | U device/location assertions; `t()` leaves an unmatched placeholder visible rather than blanking it |
| B5 | **PASS** | C server text is still written on every row, now always equal to the render for that reader — an old client reading `payload.*` gets its own language, which is strictly better than before |

### C. Push

| ID | Status | Evidence |
|---|---|---|
| C1 | **PASS** | P `push-device-locale.test.ts` "one push per device, each in that device's own language" |
| C2 | **PASS** | P same suite |
| C3 | **PASS** | U `session-locale-refresh` + gateway publish tests — §4.3 closes the previously-open gap |
| C4 | **PASS** | P "falls back to the account language for a device that never declared one" / "ignores an unsupported stored tag rather than answering in the default" |
| C5 | **PASS** | C both sides now read the same client-declared value, and `locale:set` re-syncs the device token to the socket's language |

### D. Session-based rendering & persistence

| ID | Status | Evidence |
|---|---|---|
| D1 | **PASS** | C REST re-renders from the ticket per read (`x-lang`); live frames per socket. U REST suite renders one row as three languages |
| D2 | **PASS** | C stored text is fallback only; every read path replays the ticket. U both halves proven to move together |
| D3 | **PASS** | C handshake re-runs on reconnect (`skipMiddlewares: false`); `locale:set` mutates the open socket |
| D4 | **PASS** | C first REST read carries `x-lang`; first frame uses the handshake locale — both now resolve from the same declared value (`ace075b7`) |
| D5 | **PASS** | U REST suite renders one stored row in three languages for the same viewer |

### E. Socket events

| ID | Status | Evidence |
|---|---|---|
| E1 | **PASS** | `ace075b7` covered the system-message/preview family (`community:added`, `group:added`, auto-delete label, stream duration); this change covers the notification family incl. `notification:updated` |
| E2 | **PASS** | C every frame for one action renders at delivery from the same `socket.data.locale` |
| E3 | **PASS** | C `locale:set` mutates in place; a frame renders wholly before or wholly after — the envelope and payload come from one call, so they cannot straddle the change |

### F. Enforcement

| ID | Status | Evidence |
|---|---|---|
| F1 | **PASS** | U registry-driven sweep asserts `payload.* === envelope.*` for every builder; the invariant is equality, so it holds even where the heading rule declines to replace |
| F2 | **PASS** | Grep sweep: zero immediately-invoked copy builders (which would freeze a locale before the recipient is known); `getUserLocale` has exactly one caller, documented as the write-time fallback; no `currentLocale()` in notifications-service outside a comment |
| F3 | **PASS** | U orphaned ticket → stored sentence, never the ref; malformed ticket → no throw; unsupported locale → previous value kept, never `DEFAULT_LOCALE` |
| F4 | **PASS** | One renderer (`renderNotificationCopy` / `renderNotificationData` in `@aimess/constants`), one resolver per scope, and the duplicated ticket-forwarding collapsed into the shared `copyTickets` |

**N/A:** none of the scenarios; the N/A rows in §5 are producers with no product copy
(data-only signals, admin-authored announcements, session-less email), each stated with a reason.

---

## 8. Test results

Full monorepo suite (`node node_modules/jest/bin/jest.js`), with these changes:

```
Test Suites: 16 failed, 413 passed, 429 total
Tests:       62 failed, 5395 passed, 5457 total
```

Failing-suite lists compared as sets against the run taken at `ace075b7` (the commit this
work starts from):

```
NEW failures introduced by this change:   (none)
Present in baseline, passing now:         (none)
```

The same 16 suites fail before and after — chat-service ×11, backoffice ×3, stream ×1, and
api-gateway's `stream-leave-idempotency` ×1. All pre-existing, none in a file this change
touches. The comparison was taken without stashing (see §10).

Per project, with the new suites:

| Project | Result |
|---|---|
| api-gateway | `1 failed, 45 passed` suites — the pre-existing `stream-leave-idempotency`; the 4 notification suites are `118 passed, 118 total` |
| chat-service | new `notification-envelope-payload` suite `8 passed, 8 total` |
| notifications-service | `27 passed, 27 total` suites — `302 passed, 302 total` tests |

Two consecutive full-matrix runs were taken; both reported the same 16 pre-existing failures
and no new ones. Typecheck clean: `@aimess/constants`, `@aimess/redis`, `@aimess/api-gateway`,
`@aimess/chat-service`, `@aimess/notifications-service`.

---

## 9. Client contract — what remains on the apps

The server is now internally consistent on every channel. Two items still need client work, and
neither is in this repo:

1. **Prefer the key.** Socket frames carry `data.copyRef` (`{"ref":"…","args":[…]}`); REST rows
   deliberately strip it (`stripInternalDirectives`) so a client is not tempted to
   re-implement the copy catalog for a channel the server already renders per reader. If the
   clients adopt key-based rendering, expose it on REST too and drop it from the strip list —
   the tickets and the renderer are already shared code.
2. **Declare the language on both rails.** `lang` in the socket handshake *and* `lang` on
   `POST /devices`, plus `locale:set` when the user switches. The last of those now also
   re-points the device token, so a client that only sends `locale:set` still gets its push
   language fixed.

---

## 10. Note on concurrent work in the tree

Another change landed in the working tree while this one was in progress — the invite-link
rule moving from "expires 1 hour after creation" to "lives until revoked", across
`packages/constants/src/invite-link.ts` and three test files. It is not part of this work and
was left untouched.

It is recorded here only because it briefly showed up as a failure in
`apps/chat-service/tests/groups/group-invite-link.test.ts` while its source and its tests were
half-landed (`TypeError: Cannot read properties of null (reading 'getTime')` — the old test
asserting a 1-hour stamp against the new implementation that returns `null`). Once both halves
were present the suite passed again, unchanged by anything here. The two changes share no code.

Worth noting for anyone repeating this audit: baselining by `git stash`-ing the whole tree is
unsafe while someone else is editing it — it can separate a half-landed change from its tests
and produce failures that belong to neither branch of the work. The per-suite comparisons in §8
were re-taken without stashing.
