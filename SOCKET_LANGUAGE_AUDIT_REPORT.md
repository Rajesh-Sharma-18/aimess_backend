# Socket Language Audit — one action, one language

**Date:** 2026-08-26 · **Branch:** `rajesh-dev` · **Baseline commit:** `f3e8dfab`

Reported: adding a member to a community delivered two events, seconds apart, to the same
device — an English `community:added` list row and a Vietnamese `community:message:new`
system line — on a session whose language was English.

---

## 1. Root cause

There are **two** independent causes, and both had to be true to produce the reported
screenshot. Either one alone would have been invisible.

### 1.1 Where the Vietnamese came from: `DEFAULT_LOCALE`

`resolveHandshakeLocale` (`apps/api-gateway/src/sockets/auth.middleware.ts`) resolved a
connection's language from this chain:

```
auth.lang | auth.locale | auth.language | query.lang | query.locale | query.language
  → x-lang header
  → Accept-Language header
  → DEFAULT_LOCALE
```

`DEFAULT_LOCALE` is `"vi"` in production (`packages/constants/src/locale.ts`:
`process.env.NODE_ENV === "production" ? "vi" : "en"`). A client that sends none of the
above therefore opened every socket in **Vietnamese**, permanently, regardless of what the
user had chosen in the app.

`community:message:new` is — and already was — re-rendered *per receiving socket* from
`socket.data.locale` (`emitPersonalizedSender` → `personalizeCommunitySocketMessage`). So it
rendered faithfully in the language the socket had asked for. The socket had asked for
Vietnamese. **The system line was not broken; it was the only event honest enough to show
the connection's real locale.**

The corroborating log line already exists: the gateway emits
`[socket:locale] resolved=… source=…`, and `source=default` on this connection is the direct
evidence — it means the client declared nothing, so nothing "leaked" from another session
(nothing in the socket delivery path is keyed by user).

### 1.2 Why the row looked right: it was never localized at all

`community:added` had **no personalizer registered** in the gateway's `/community` relay.
The map covered exactly two events:

```ts
parsed.event === "community:message:new"  ? personalizeCommunitySocketMessage
: parsed.event === "community:updated"    ? personalizeCommunityUpdatedPreview
: undefined                               // ← community:added landed here
```

So `lastActivity.preview` was emitted byte-for-byte as the producer baked it — and the two
producers in `community.service.ts` baked it from **two different language sources**:

| Producer | Path | Locale used |
|---|---|---|
| `notifyMemberJoined` | admin add / join-request approval / invite redeem / self-join | `STORED_TEXT_LOCALE` (**English constant**) |
| `create()` | community created | `currentLocale()` — the **creating admin's HTTP request** language |

The join path baked English. On an English session that is right *by accident*; on any other
session it is wrong, and on the create path a second device of the same user in another
language got the language of whichever device issued the `POST`.

**The mismatch is therefore structural, not a race:** one event followed the socket, the
other followed a constant. They can only agree when the socket happens to be English.

> Note on the pasted evidence: it shows `via: "add_members"` with
> `systemMessageType: "COMMUNITY_JOINED"`. Current `main` maps `add_members → MEMBER_ADDED`
> (commit `56fcdd89`), so that capture predates it. It does not change the diagnosis — the
> language split is identical for either subtype.

---

## 2. Open questions — answers used

| # | Question | Decision | Basis |
|---|---|---|---|
| 1 | Language scope | **Session/connection-level**, per device | Already the architecture (`socket.data.locale` + `x-lang` + `DeviceToken.locale`). The account field (`AppSettings.language`) is one column that the last session to change it overwrites for everyone, so it is a fallback only. |
| 2 | Architecture | **Keys + params on the wire; server text is legacy fallback** | Already true for SYSTEM lines and notification rows. Extended here to the last three surfaces that shipped baked text with no key. |
| 3 | History re-localization | **Yes** | Falls out of key-based rendering. Rows persist `STORED_TEXT_LOCALE` English + the canonical event; every read path re-renders. No requirement found to preserve "language at time of event". |
| 4 | Supported languages | `en`, `vi`, `th` (`SUPPORTED_LOCALES`). Fallback = `DEFAULT_LOCALE` (`vi` prod / `en` dev/test); unknown keys fall back to the producer's baked sentence, never a raw key. | `packages/constants/src/locale.ts` |
| 5 | Push in scope | **Yes**, audited; already per-device via `DeviceToken.locale`. One producer fixed (see 4.6). | `push.service.ts` `viewFor` |

---

## 3. Language Flow Map

### 3.1 The four scopes (unchanged model)

| Scope | Owner | Storage | Decides |
|---|---|---|---|
| Request | client, per REST call | `x-lang` header → `AsyncLocalStorage` | every REST response |
| **Connection** | client, per socket | `socket.data.locale` (gateway memory) | live SYSTEM text, list previews, `notification:new`, acks |
| Delivery | client, at device registration | `DeviceToken.locale` | push tray text |
| Account | last session that changed it | `AppSettings.language` | OTP/reset emails, stored fallback text — **and now the handshake's last resort** |

### 3.2 Before → after

```
BEFORE
  handshake:  declared → x-lang → Accept-Language → DEFAULT_LOCALE ("vi" in prod)   ← the bug
  community:message:new     → per socket        ✅
  community:updated         → per socket        ✅
  conv:updated / message:new→ per socket        ✅
  notification:new          → per socket        ✅
  community:added           → producer-baked    ❌ (English const OR actor's request locale)
  group:added               → producer-baked    ❌ (DB snapshot, write-time English)
  conv:auto_delete:updated  → SETTER's request locale, pushed to the peer   ❌
  community:stream:ended    → write-time English, broadcast to the room     ❌
  admin ban/suspend/unban   → English string literals, no replay ticket     ❌

AFTER
  handshake:  declared → x-lang → ACCOUNT LANGUAGE → Accept-Language → DEFAULT_LOCALE
  every event above → per receiving socket, from a key or a numeric input
  admin ban/suspend/unban → accountCopy builder + replay ticket + per-device push render
```

---

## 4. Audit table — event × field × language source

Legend: **per-socket** = re-rendered for each receiving connection; **per-reader** = re-rendered
in the REST caller's `x-lang`; **per-device** = rendered from `DeviceToken.locale`.

| Surface | Field | Before | After | Change |
|---|---|---|---|---|
| `community:message:new` | `message`, `content.text` | per-socket | per-socket | — (socket locale itself fixed) |
| `community:updated` | `lastMessage.text` | per-socket | per-socket | — |
| `message:new` (group/private) | `contentText`, `content.text` | per-socket | per-socket | — |
| `conv:updated` | `lastMessage.text` | per-socket | per-socket | — |
| `notification:new` | `title`, `body`, `resolution` | per-socket (replay ticket) | per-socket | — |
| socket acks | `message` | per-packet ambient locale | same | — (`f3e8dfab`) |
| `auth:session_terminated` | `message` | localized | same | — (`f3e8dfab`) |
| REST chat history / inbox / notification list | all copy | per-reader | per-reader | — |
| push tray | `title`, `body` | per-device | per-device | — |
| **`community:added`** | `lastActivity.preview` | **baked (2 different sources)** | **per-socket via `previewKey`** | §4.1 |
| **`group:added`** | `lastMessage.text` | **baked (DB snapshot)** | **per-socket** | §4.2 |
| **`conv:auto_delete:updated`** | `label` | **setter's request locale** | **per-socket from `ttlSeconds`** | §4.3 |
| **`community:stream:ended`** | `duration` | **write-time English** | **per-socket from `durationSeconds`** | §4.4 |
| **admin ban / suspend / unban** | `title`, `body` | **English literals, no ticket** | **per-reader + per-device** | §4.6 |
| socket handshake | `socket.data.locale` | → `DEFAULT_LOCALE` | → **account language** → default | §4.5 |
| `community:closed` | `reason` | code (`ADMIN_BANNED`) or owner free text | unchanged | N/A — not product copy |
| `community:member:removed` / `:banned` / `:muted` | all | codes + ids only | unchanged | N/A |
| `/stream` events | `title`, `description` | user content | unchanged | N/A |

### 4.1 `community:added` — key on the wire, rendered per socket

`CommunityLastActivity` gains an optional `previewKey`: the `@aimess/constants` message key
the sentence was rendered from. It applies only to the parameter-less lifecycle sentences
(join / added / created), which is all this payload ever carries.

- `community.service.ts` now bakes `preview` in `STORED_TEXT_LOCALE` on **both** producers
  (the create path stopped using `currentLocale()`) and ships `previewKey` alongside.
- The gateway registers `personalizeCommunityAddedPreview` for `community:added`, which
  re-renders `preview` from the key in the receiving socket's locale.

Why a key rather than reusing `systemMessageType`: the list preview is deliberately a
*different sentence* from the timeline line for `MEMBER_ADDED` — the row is actor-less
("You were added to the community") because community-service does not resolve the adding
admin's display name, while the timeline line names them ("{admin} added you to the
community"). `systemMessageType` would re-render the timeline sentence into the row.

### 4.2 `group:added`

`group:added` republishes `GroupRoom.lastMessagePreview` verbatim — the same
`{type, lastMessage}` shape `conv:updated` carries, so it now reuses
`personalizeConvUpdatedPreview` unchanged. One incompatibility had to be closed: the DB
snapshot spells the field `messageType`, while only the `conv:updated` bump normalizes it to
`contentType`. `withRebuiltPreviewText` now reads either, so a group SYSTEM row arriving via
`group:added` is no longer mistaken for a media label and skipped.

### 4.3 `conv:auto_delete:updated`

The timer belongs to the *conversation*, so one payload is published to every participant —
but `label` was rendered by `buildAutoDeleteWire` inside the PUT request of whoever changed
it. A Thai user enabling a 24-hour timer pushed a Thai label onto their English peer's gear
menu. `ttlSeconds` is in the same payload and is the label's only input, so
`personalizeAutoDeleteLabel` re-derives it per socket. Covers private and group (both
publish on `user:<id>`).

### 4.4 `community:stream:ended`

`duration` ("1h 24m") is broadcast to the whole community room, so it could only ever be
baked in one language. `durationSeconds` rides along for exactly this reason;
`personalizeStreamDuration` re-derives the label per socket.

### 4.5 The handshake's account-language rung

The account language is a language the user actually **chose**, which makes it a strictly
better last resort than the server default. It is inserted **below** anything the connection
declared (a declared value is this session speaking, and outranks an account-wide column
five sessions overwrite) and **above** `Accept-Language` (which is the device/OS, not a
choice).

- `UserClient.getAppLanguage(userId)` reads it over the existing `GetNotificationSettings`
  RPC — that message already carries `language`, so no contract change.
- Uncached on purpose: paid once per handshake, and only for a connection that declared
  nothing. A cache would buy nothing and could serve a language changed between two logins.
- Fails soft: an unreachable user-service means this rung has no answer and the chain falls
  through. It can never fail a handshake.
- Wired through a one-value registry (`sockets/account-locale.ts`) rather than a parameter,
  because `createGatewaySocketAuthMiddleware` is constructed by five namespaces and three of
  them (`/notify`, `/stream`, `/auth`) hold no user client. Unset — the state every unit
  suite runs in — leaves the previous chain byte-identical.

### 4.6 Admin ban / suspend / reinstate notifications

These were the *one* class of notification a user cannot switch off (exempt from the category
toggles and from quiet hours via `NON_SUPPRESSIBLE_TYPES`) and the last one still built from
English string literals — in auth-service's `admin-user-consumer.ts`, which runs on an
**admin's** action and cannot know what language the affected user reads.

New `accountCopy` builders (`banned` / `suspended` / `reinstated`) + six catalog keys in
en/vi/th. notifications-service picks the builder off the event type and hands it to
`pushToUser`, which renders the stored row in the recipient's account language, attaches the
`copyRef` replay ticket (so the Notification Center re-renders after a language change), and
renders the tray text once per device locale. auth-service's literals stay as the legacy
fallback for an unrecognized event type, now documented as such.

### 4.7 Grep-level sweep (D5) — call sites reviewed, no change needed

- All 22 `currentLocale()` call sites reviewed. Every one outside `community.service.ts` is a
  read path (REST serializer / per-viewer rebuild), which is correct by construction.
- `session.service.ts`'s `"Session terminated." / "This was you."` literals are **inert**:
  login-alert rows ignore the `body` argument (their status is `data.actionTaken`) and the
  serializer renders the status per reader. Left as-is, matching the existing comment in
  `sweepExpiredLoginNotifications`.
- `buildClosedBanner` already ships `messageKey` + rendered text — the pattern this report
  generalizes.
- `/stream` payloads carry ids, booleans and user content only.
- Zod validator messages (`app-version.validator.ts`, backoffice validators, …) are English.
  Out of scope — they are field-level validation detail behind `error.code`, which is what
  clients render, and localizing them is a separate project. **Recorded, not fixed.**

---

## 5. Code changes

| File | Change |
|---|---|
| `packages/constants/src/i18n.ts` | `renderMessageKey(key, locale, params)` — guarded `t()` that returns `null` for a key this build lacks instead of echoing the key. |
| `packages/constants/src/messages/notification.messages.ts` | 6 keys: `NOTIF_ACCOUNT_{BANNED,SUSPENDED,REINSTATED}_{TITLE,BODY}` in en/vi/th. |
| `packages/constants/src/notification-copy.ts` | `accountCopy` namespace (`banned`/`suspended`/`reinstated`). |
| `packages/shared-types/src/community.ts` | `CommunityLastActivity.previewKey?` (SYSTEM variant). |
| `apps/community-service/src/types/community.types.ts` | Same field on the service-local type. |
| `apps/community-service/src/services/community.service.ts` | Join + create previews baked in `STORED_TEXT_LOCALE` and carrying `previewKey`; `SELF_JOIN_ACTIVITY_PREVIEW` derived from the catalog instead of a literal. |
| `apps/api-gateway/src/sockets/system-message-personalize.ts` | `personalizeCommunityAddedPreview`, `personalizeAutoDeleteLabel`, `personalizeStreamDuration`; `messageType` accepted as a `contentType` alias. |
| `apps/api-gateway/src/sockets/namespaces/community.ns.ts` | Register the `community:added` and `community:stream:ended` personalizers. |
| `apps/api-gateway/src/sockets/namespaces/chat.ns.ts` | Register the `group:added` and `conv:auto_delete:updated` personalizers. |
| `apps/api-gateway/src/sockets/auth.middleware.ts` | `declaredHandshakeLocale()` split out; account-language rung after verification. |
| `apps/api-gateway/src/sockets/account-locale.ts` | **New** — the resolver registry. |
| `apps/api-gateway/src/grpc/clients/user.client.ts` | `getAppLanguage()` over `GetNotificationSettings`. |
| `apps/api-gateway/src/sockets/index.ts` | Register the resolver before any namespace. |
| `apps/api-gateway/src/docs/openapi/components/schemas.ts` | Document `previewKey` and the `preview` locale contract. |
| `apps/notifications-service/src/consumers/admin-user.consumer.ts` | Map event type → `accountCopy` builder, pass as `copy`. |
| `apps/auth-service/src/messaging/admin-user-consumer.ts` | Comment: these literals are the legacy fallback; do not localize here. |

No migrations. No new dependencies. Every wire field added is optional and additive — an old
client that ignores `previewKey` behaves exactly as before.

---

## 6. New tests

`apps/api-gateway/tests/sockets/join-event-locale.test.ts` (10 tests)
- `community:added` renders in en/vi/th from the key.
- Row and system line of the **same add** agree on language in every locale.
- The reported repro: an English session gets neither event in Vietnamese.
- Unknown key → keeps the baked sentence (never shows `SYS_…`).
- Legacy row with no key → returned by reference, untouched.
- Two devices of one account, two locales, one publish → two languages.
- `group:added` rebuild on the `messageType` snapshot shape, incl. the added member's
  first-person line.

`apps/api-gateway/tests/sockets/handshake-account-locale.test.ts` (6 tests)
- Silent client answered in its account language.
- Account never outranks `auth.lang` / `query.locale` / `x-lang`.
- Account outranks `Accept-Language`.
- No account language → `DEFAULT_LOCALE`.
- user-service throwing never fails the handshake.
- No resolver registered → previous behaviour exactly.

---

## 7. Scenario matrix

Evidence types: **U** = unit/integration test in this repo, **C** = code path verified by
reading the single call site, **P** = pre-existing test suite covering it.

### A. The core bug

| ID | Expected | Status | Evidence |
|---|---|---|---|
| A1 | English session: both events English | **PASS** | U `join-event-locale` "the exact reported repro" + `handshake-account-locale` |
| A2 | Non-English session: both events in that language | **PASS** | U parameterized en/vi/th |
| A3 | Row and line agree per action | **PASS** | U "agrees with the system line of the SAME add". Wording differs by design for `MEMBER_ADDED` (actor-less row vs. actor-named line) — §4.1 |
| A4 | `systemMetadata` intact, names not translated | **PASS** | U asserts the interpolated actor survives verbatim; P `per-recipient-locale` "never translates the interpolated names" |
| A5 | Message list + community list + last-message summary all in session language | **PASS** | U (`community:added`) + P `list-preview-locale` (`community:updated`, `conv:updated`) + C REST `selectListPreview` → `localizeSystemPreview` |

### B. Session-wise language management

| ID | Expected | Status | Evidence |
|---|---|---|---|
| B1 | Language change mid-session applies to the next event, no reconnect | **PASS** | P `handshake-locale` "moves the live locale without waiting for a reconnect" (`locale:set` mutates `socket.data.locale`, which every emit reads live) + P `ack-locale` for ack copy |
| B2 | Reconnect / resume keeps the right language | **PASS** | C `connectionStateRecovery.skipMiddlewares: false` re-runs the handshake; the chain is deterministic and now ends at the account language, not the server default |
| B3 | Cold start correct on first render | **PASS** | C REST reads use `x-lang`; the first socket frame uses the handshake locale. Both now resolve to the same language for a silent client (account), where before they diverged (`en` vs `vi`) — that divergence *was* the flash |
| B4 | Two devices, two languages, one event | **PASS** | U "gives two devices of the SAME account two languages from one publish"; P `per-recipient-locale` for group SYSTEM |
| B5 | Device 1's change does not move device 2 | **PASS** | C `locale:set` mutates one `socket.data`; nothing in the delivery path is keyed by user |
| B6 | Logged-out / login resolves to the session's setting | **PASS** | C `x-lang` on the auth REST calls; OTP mail uses the account field by design (no session exists) |

### C. History & persistence

| ID | Expected | Status | Evidence |
|---|---|---|---|
| C1 | History renders in the current language | **PASS** | P chat-service serializers re-render from `systemEvent`/`systemMessageType` per reader |
| C2 | Previews after reload in current language | **PASS** | C `localizeSystemPreview` (community REST) + `localize-system-preview.ts` (chat REST) |
| C3 | Pre-change rows re-render after a language switch | **PASS** | C rows persist `STORED_TEXT_LOCALE` + the canonical event; the rebuild is unconditional. Same always-rebuild gate that retro-fixed `JOIN_REQUEST_APPROVED` rows with no migration |
| C4 | New clients override persisted text; no mixed languages on one screen | **PASS** | Server already re-renders both halves; `previewKey` gives clients the key too |

### D. The whole bug class

| ID | Expected | Status | Evidence |
|---|---|---|---|
| D1 | Every text-bearing event verified in 2+ languages | **PASS** | Audit table §4 — every row is either per-socket/per-reader/per-device, or carries no product copy |
| D2 | Every `systemMessageType` renders per language, params included | **PASS** | P `buildCommunitySystemFallbackText` covers all 24 subtypes with a `default` arm; plural/duration handled by `formatMuteDuration`/`formatTtlDuration`/`formatStreamDuration`, all locale-parameterized |
| D3 | Notifications correct per device | **PASS** | C `push.service.ts` `viewFor` renders per `DeviceToken.locale`; §4.6 closed the last producer with no ticket |
| D4 | Unknown key / unsupported language → safe fallback, never a raw key | **PASS** | U "keeps the baked sentence for an unknown key"; `renderMessageKey` returns `null` rather than the key; `parseSupportedLocale` returns `null` for unsupported tags instead of normalizing them onto `DEFAULT_LOCALE` |
| D5 | No path builds recipient text from the actor's or a cached locale | **PASS** | §4.7 sweep. Three actor-locale paths found and fixed (`create()` preview, auto-delete label, admin notify); the cached-locale class was closed in `f3e8dfab` |

### E. Consistency & races

| ID | Expected | Status | Evidence |
|---|---|---|---|
| E1 | Two events for one action agree | **PASS** | U "agrees with the system line of the SAME add" — both now resolve from the same `socket.data.locale` at delivery |
| E2 | Language change while an action is in flight → language at delivery time wins | **PASS** | C both events render inside `emitPersonalizedSender`, reading `socket.data.locale` at emit. A `locale:set` between the two flips both or neither — never one |
| E3 | Old clients still get usable text | **PASS** | C every producer still bakes a real sentence; `previewKey` is additive and ignorable |

**N/A:** none. Every scenario has a verdict.

---

## 8. Test results

Full monorepo suite (`node node_modules/jest/bin/jest.js`), with these changes:

```
Test Suites: 16 failed, 410 passed, 426 total
Tests:       62 failed, 5325 passed, 5387 total
```

Compared against a `git stash`ed HEAD baseline of the same command, on normalized suite
paths:

```
--- NEW failures introduced by this change ---
(none)
--- present at HEAD, absent here ---
apps/community-service/tests/mute/auto-unmute-sweeper.test.ts
```

All 16 failing suites are pre-existing (chat-service ×11, backoffice ×3, stream ×1,
api-gateway `stream-leave-idempotency` ×1) and unrelated — none of them is in a file this
change touches. The one difference is `auto-unmute-sweeper.test.ts`, which fails at HEAD and
passes with the working-tree edit that was already present when this work started (someone
else's in-flight fix, untouched here).

api-gateway project, two consecutive runs: `1 failed, 44 passed` / `8 failed, 492 passed`
tests — the same pre-existing `stream-leave-idempotency` suite both times, with all 16 new
tests green.

Typecheck clean: `@aimess/constants`, `@aimess/shared-types`, `@aimess/api-gateway`,
`@aimess/community-service`, `@aimess/chat-service`, `@aimess/notifications-service`.

---

## 9. Client contract — what the apps must still do

The server is now correct for a silent client, but "correct" there means *the account
language*, which is one slot shared by every session. Per-**session** language only works if
the client says which language it is:

1. **Handshake** — send the selected language in the connect packet: `auth: { lang: "en" }`
   (or `query.lang`). `lang` / `locale` / `language` are all accepted, in both `auth` and
   `query`. A browser cannot set headers on a websocket upgrade, so this is the only channel
   that works everywhere.
2. **Live change** — emit `locale:set` with `{ lang: "th" }` (or a bare `"th-TH"`) when the
   user switches. It mutates the open connection; no reconnect. The ack returns
   `{ success, data: { locale } }` — `success: false` means the build does not carry that
   language and the previous one was kept.
3. **REST** — keep sending `x-lang` on every call.
4. **Device registration** — send `lang` on `POST /devices` so the push tray follows the
   device, not the account.
5. **Rendering** — prefer `systemMessageType` + `systemMetadata` (timeline) and `previewKey`
   (list row) over the server-rendered string, and fall back to the string when the key is
   absent or unknown. Never display a key.

Verification aid: the gateway logs `[socket:locale] resolved=<locale> source=<rung>` on every
handshake. `source=default` now means the client declared nothing **and** the account has no
language — a client finding, not a gateway one.

---

## 10. Known remaining gaps (recorded, not fixed)

| Gap | Why it was left |
|---|---|
| Zod validator messages are English across all services | Field-level validation detail behind `error.code`, which is what clients render. Localizing them is a separate project with its own catalog surface. |
| `AppSettings.language` remains last-writer-wins across sessions | Structural and intended — it is the fallback for surfaces with no session (OTP mail) and the handshake's last resort. Per-session correctness comes from the client declaring its language, §9. |
| Livestream `title` / `description`, filenames, place names | User content, never translated. |
