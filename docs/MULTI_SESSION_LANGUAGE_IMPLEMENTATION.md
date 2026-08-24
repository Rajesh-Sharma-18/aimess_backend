# Per-Session Language — Implementation Guide (Backend · Web · Android · iOS)

**Scenario this document solves.** One account, five live sessions. Two chose Vietnamese, one
Thai, two English. Every session must read notifications, push banners, SYSTEM chat lines and list
previews in _its own_ language. Mid-stream, one of the English sessions switches to Thai — that
session must flip immediately, and the other four must not move.

**Status.** Most of the spine already existed and worked per session. Exactly one dimension was
still account-scoped and broke the scenario: **the push notification payload**.

| Part                                                                                                      | State                                     |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Backend (§3) — `DeviceToken.locale`, `lang` on device registration, per-device render in the push fan-out | **Shipped**                               |
| Website (§5)                                                                                              | **Shipped**                               |
| Android (§6.4) / iOS (§6.5)                                                                               | **To do** — this document is the contract |
| Mobile offline-DB repair (§6.1–§6.3)                                                                      | **To do**                                 |

Old clients need no change at any point: a device that sends no language keeps falling back to the
account setting, which is exactly the previous behaviour.

---

## 1. The model: three locale scopes

Language is not one setting. It resolves from three different places depending on whether there is
a request, a socket, or neither. Getting these confused is what makes a "language bug" un-fixable.

| Scope                                  | Who owns it                  | Storage                                              | Surfaces it decides                                                                                                                       |
| -------------------------------------- | ---------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Request locale** (per REST call)     | the client, per request      | none — `x-lang` header                               | every REST response: chat history, notification list, list previews, error messages, ack copy                                             |
| **Connection locale** (per socket)     | the client, per connection   | `socket.data.locale`, in memory on the gateway       | live `message:new` SYSTEM text, `conv:updated` / `community:updated` previews, `notification:new` frames, socket acks                     |
| **Delivery locale** (per device token) | the client, at registration  | **`DeviceToken.locale` — the field this guide adds** | the push notification tray text (FCM / APNs), for a device that may be asleep with no request and no socket                               |
| **Account locale** (fallback)          | last session that changed it | `AppSettings.language` (user-service)                | only the surfaces with no session at all: OTP emails, password-reset emails, and the _stored fallback text_ baked into a notification row |

The rule to hold on to:

> **Display is per session. Delivery is per device. The account field is only for things that
> happen when nobody is logged in anywhere.**

### Why the account field cannot be the answer

`AppSettings.language` is one column on one row. Five sessions writing it is last-writer-wins, so
the moment session #4 picks Thai, the two Vietnamese sessions start getting Vietnamese-user pushes
in Thai. That is precisely the reported symptom. The field stays — it is the right answer for an
OTP email, where there is no session to ask — but it must stop deciding push copy.

---

## 2. What already works today (do not rebuild it)

Verified in the current tree. These paths are already per-session correct:

| Surface                                | Mechanism                                                                                                                                                                                                          | Code                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| REST, all services                     | `localeMiddleware` reads `x-lang`, publishes it on an `AsyncLocalStorage` ambient context that serializers and outgoing gRPC calls both read                                                                       | `packages/utils/src/locale-middleware.ts`, `packages/constants/src/locale-context.ts` |
| Socket handshake                       | `resolveHandshakeLocale` reads `auth.lang` → `auth.locale` → `query.lang` → `x-lang` → `Accept-Language`. Client-sent values win over headers **on purpose** — a browser cannot set headers on a websocket upgrade | `apps/api-gateway/src/sockets/auth.middleware.ts:67`                                  |
| Live language switch on an open socket | `locale:set` packet mutates `socket.data.locale` in place; installed once in `scopeSocketLocale`, so all four namespaces (`/chat`, `/community`, `/notify`, `/stream`) get it                                      | `apps/api-gateway/src/sockets/locale-scope.ts`                                        |
| Per-packet ambient locale              | `socket.use()` wraps every inbound packet in `runWithLocale`, so gRPC calls made by a socket handler forward `x-lang` too                                                                                          | `apps/api-gateway/src/sockets/locale-scope.ts:24`                                     |
| Per-recipient socket fan-out           | `emitPersonalizedSender` walks the room's sockets and re-renders per socket instead of broadcasting one frame                                                                                                      | `apps/api-gateway/src/sockets/emit-personalized.ts`                                   |
| SYSTEM chat lines                      | stored in English (`STORED_TEXT_LOCALE`) plus the canonical `systemEvent` + `systemData` they were built from; re-rendered per reader                                                                              | `packages/constants`, `apps/chat-service/src/lib/chat-message.serializer.ts:870`      |
| List previews (private + group)        | bump payload carries `systemEvent`/`systemData`; REST rebuilds via `localize-system-preview.ts`                                                                                                                    | `apps/chat-service/src/lib/localize-system-preview.ts`                                |
| Notification Center rows               | row stores a **replay ticket** (`data.copyRef` / `data.dataRef` = builder ref + args), replayed at read in the reader's locale                                                                                     | `apps/chat-service/src/lib/notification-serializer.ts:280`                            |

So: a session that sends the right `x-lang` and the right handshake `lang`, and emits `locale:set`
when the user switches, is **already fully correct for everything except the push tray**.

---

## 3. The one real gap: push is rendered once per user

`apps/notifications-service/src/services/push.service.ts` currently does this:

```ts
// line ~385
const locale = await getUserLocale(userId).catch(() => DEFAULT_LOCALE); // account-wide
const rendered = input.copy?.(locale);
const title = rendered?.title ?? input.title ?? "";
const body   = rendered?.body  ?? input.body  ?? "";
// … later …
await Promise.all(tokens.map(async ({ token }) => sendPush({ token, title, body, … })));
```

One locale, resolved from the account, applied to **every** device token. Five sessions, one
language. That is the bug in one line.

### 3.1 Backend change — six files, no migration

#### (a) `apps/notifications-service/prisma/schema.prisma`

```prisma
model DeviceToken {
  …
  sessionId  String?
  /// Delivery locale for THIS device's push tray text ("en" | "vi" | "th").
  /// Session-scoped on purpose: one account can be signed in on five devices in
  /// three languages, and `AppSettings.language` is a single account-wide slot
  /// that the last session to change it overwrites for everyone.
  /// Null = never sent one (legacy row, or an older client) → fall back to the
  /// account language, which is exactly the previous behaviour.
  locale     String?
  lastSeenAt DateTime @default(now())
  …
}
```

MongoDB + nullable → `pnpm --filter @aimess/notifications-service db:push` and
`db:generate`. No migration, no backfill, no downtime. Existing rows keep working unchanged.

#### (b) `packages/constants/src/locale.ts` — one shared parser

`locale-scope.ts` already has a `parseClientLocale` that accepts `"th"` / `"th-TH"` /
`{lang}` / `{locale}` and **returns null for anything unsupported instead of normalizing it**.
That "ignore, never normalize" rule is load-bearing: `resolveLocale` maps an unknown value onto
`DEFAULT_LOCALE`, which is `vi` in production — i.e. a client sending a language this build does
not carry would be answered in Vietnamese. Export the parser so the device controller uses the
same rule rather than a second copy:

```ts
/** Base language tag if this build carries it, else null. Never normalizes to a default. */
export function parseSupportedLocale(raw: unknown): SupportedLocale | null {
  if (typeof raw !== "string") return null;
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  return isSupportedLocale(base) ? base : null;
}
```

Then `locale-scope.ts`'s local copy becomes a call to this. (Editing `packages/constants/src`
requires a manual package rebuild before services see it.)

#### (c) `apps/notifications-service/src/repositories/device-token.repository.ts`

```ts
export interface UpsertDeviceTokenInput {
  …
  /** Delivery locale for this device, already validated; null = no opinion. */
  locale?: SupportedLocale | null;
}

export interface DeviceTokenRow {
  …
  locale: string | null;
}
```

In `upsert`, set it **unconditionally** — `locale: input.locale ?? null` in both `create` and
`update` — and add `locale: true` to the `select` in `findTokensByUserId`.

Unconditional is the load-bearing choice. The column means _"what the client that currently owns
this token last said"_. Only writing when a value is present looks safer (an older build would not
wipe a newer one's value) but `token` is `@unique`, so **re-registration is exactly how a token
moves between accounts** — a sticky locale would hand the new owner the previous owner's language.
A pre-upgrade build falling back to the account setting is a much smaller problem than a
cross-account language leak.

#### (d) `apps/notifications-service/src/api/validators/device.validator.ts`

```ts
export const registerDeviceSchema = z.object({
  token: z.string().min(1).max(4096),
  platform: z.enum(["ANDROID", "IOS", "WEB"]),
  tokenType: z.enum(["FCM", "VOIP"]).default("FCM"),
  deviceId: z.string().min(1).max(256).optional(),
  /** Push tray language for this device. Region tags accepted ("th-TH" → "th").
   *  Unsupported values are ignored, not defaulted. */
  lang: z.string().min(2).max(16).optional(),
});
```

#### (e) `apps/notifications-service/src/api/controllers/device.controller.ts`

```ts
await deviceTokenService.registerDevice({
  userId: req.auth.userId,
  token: body.token,
  platform: body.platform,
  tokenType: body.tokenType,
  deviceId: body.deviceId ?? null,
  sessionId: req.auth.sessionId,
  // Client-declared, not header-derived: `x-lang` on this one call is the
  // language of the *request*, which is the same thing right now but would
  // silently drift if registration ever moved to a background worker.
  locale: parseSupportedLocale(body.lang),
});
```

(Pass `locale` straight through `device-token.service.ts` — one added field on the input type.)

#### (f) `apps/notifications-service/src/services/push.service.ts` — render per locale group

Keep the account locale for the **inbox row** (its stored `title`/`body` is only a fallback; the
Notification Center re-renders from the replay ticket at read time anyway). Change only the device
fan-out. The `copy` thunk is pure, so calling it up to three times per push is free; memoize so a
50-device user still renders at most once per language:

```ts
type PushView = { title: string; body: string; data?: Record<string, string> };
const views = new Map<SupportedLocale, PushView>();

const viewFor = (loc: SupportedLocale): PushView => {
  const hit = views.get(loc);
  if (hit) return hit;
  const rendered = input.copy?.(loc);
  const full = rendered?.body ?? input.body ?? "";
  const view: PushView = {
    title: rendered?.title ?? input.title ?? "",
    // Preview masking is per delivery too — the placeholder is product copy.
    body: showPreview
      ? full
      : typeof showPreviewOverride === "function"
        ? showPreviewOverride(loc)
        : (showPreviewOverride ?? t("NOTIF_CHAT_NEW_MESSAGE", loc)),
    data: input.localizedData
      ? { ...(rawData ?? {}), ...input.localizedData(loc) }
      : rawData,
  };
  views.set(loc, view);
  return view;
};
```

Then in the existing `tokens.map(...)`, take `locale` off the row and use the view:

```ts
await Promise.all(
  tokens.map(async ({ token, tokenType, platform, locale: tokenLocale }) => {
    …
    // Device locale first; account language only when this device never said.
    const view = viewFor(parseSupportedLocale(tokenLocale) ?? locale);
    …
    ? await sendVoipPush({ token, data: view.data ?? {}, ttl, collapseId: collapseKey })
    : await sendPush({
        token,
        title: view.title,
        body: view.body,
        data: view.data,
        deepLink,
        imageUrl: view.data?.communityAvatarUrl || view.data?.conversationAvatar || …,
        …
      });
  })
);
```

Everything above the fan-out (settings gate, quiet hours, community membership gate, revoked-session
pruning, VoIP collapsing) is untouched — those are account decisions and stay account decisions.

The existing `[push:deliver]` log line gained a `locales=` field naming, per token, which rung of the
ladder it used — `device` (the client declared one) or `account` (it has not yet). That is both the
adoption meter for the client rollout and the one-grep answer to the next "why is this push in
Vietnamese?" report:

```
[push:deliver] user=… type=friend.requested tokens=3 locales=device,device,account
```

> **Deliberately not done:** relaying `locale:set` from the gateway into notifications-service to
> update the token row server-side. It would save clients one call, but notifications-service's gRPC
> server is still a stub, so it costs a new RPC + client wiring + a proto change — and it would not
> cover a language changed while the socket is down. Re-registering the token is idempotent, offline-
> retryable, and something every client already does on token refresh. Revisit only if a client
> cannot re-register cheaply.

### 3.2 The check to leave behind

`apps/notifications-service/tests/services/push-recipient-locale.test.ts` proves the per-_recipient_
half (one builder fanned out to three users leaves in three languages).
`apps/notifications-service/tests/services/push-device-locale.test.ts` proves the per-_device_ half
and is what fails if anyone hoists the render back above the token fan-out:

- three tokens (`en`, `th`, `vi`) under an account set to `en` → three different bodies;
- a token with `locale: null` → the account language, not `DEFAULT_LOCALE`;
- a token holding an unsupported tag (`"fr"`) → the account language, not `DEFAULT_LOCALE`;
- six tokens across two languages → six sends, two distinct bodies (the memo holds).

`apps/notifications-service/tests/devices/register-device.test.ts` covers the write side:
`"th-TH"` → `"th"`, `"fr"` → `null` **without failing the registration** (a 400 there would leave
the device with no push at all), and a re-registration with no `lang` clearing the stored value.

---

## 4. The client contract

**Five obligations. Every platform implements all five. There are no optional ones.**

| #      | Obligation                                                                                                               | Mechanism                                                                                                                           | Consequence of skipping it                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **C1** | Send the session's language on **every REST call**                                                                       | header `x-lang: en\|vi\|th`                                                                                                         | history, notification list and previews come back in `DEFAULT_LOCALE` = **`vi` in production**             |
| **C2** | Send it on **every socket handshake**, in _both_ `auth.lang` and `query.lang`                                            | `io(url, { auth: { token, lang }, query: { token, lang } })`                                                                        | live SYSTEM messages and list bumps arrive in the wrong language until reload                              |
| **C3** | On change, **retarget the open sockets** without reconnecting                                                            | `socket.emit("locale:set", { lang })` for every namespace, **and** rewrite the stored `auth`/`query` so the next reconnect keeps it | the switch appears to work until the first token refresh or network blip silently reverts it               |
| **C4** | On change, **re-register the push token** with the new language                                                          | `POST /api/v1/devices` `{ token, platform, tokenType, deviceId, lang }`                                                             | display flips instantly, push banners stay in the old language forever                                     |
| **C5** | **Self-heal**: on every app foreground and every socket connect, if `storedLocale !== lastRegisteredLocale`, re-register | the same call as C4                                                                                                                 | one failed or offline C4 leaves that device mislabelled _permanently_ — until the FCM token itself rotates |

All five read **one** persisted per-install value. Nothing may read the OS locale for any of them:
`Accept-Language` is the phone's language, and the user picked a different one inside the app.

C5 is what makes this robust rather than merely correct — it converges without depending on the
change-time call landing. It is cheap: registration is an idempotent upsert keyed on the token, so a
redundant call is a no-op row-touch.

Both `auth` **and** `query` in C2 are required: which one survives depends on the negotiated
transport, and browsers ignore `extraHeaders` on a websocket upgrade.

Send only `en`, `vi`, `th`. Region tags (`th-TH`) are accepted and truncated server-side; anything
outside the supported set is **ignored, and the previous value is kept** — never silently
normalized to the server default.

### 4.1 Language-change sequence (all platforms)

```
user picks a language
  │
  ├─ 1. persist locally, per app-install/session  (localStorage / SharedPreferences / UserDefaults)
  ├─ 2. set the in-app UI locale                  (own catalog — unrelated to the server)
  ├─ 3. socket.emit("locale:set", { lang })       ← C3, every open namespace
  │     + rewrite stored auth.lang / query.lang   ← survives reconnect
  ├─ 4. POST /api/v1/devices { …, lang }          ← C4, push tray (every token: FCM and VoIP)
  ├─ 5. invalidate every cached server-rendered string and refetch   ← §6
  └─ 6. PATCH /users/settings/me { app: { language } }  ← account fallback, best-effort

later, unconditionally
  └─ on foreground / socket connect: re-POST /devices if the locale drifted   ← C5
```

Steps 3–6 are independent; fire them concurrently and let each fail on its own. Step 6 is
last-writer-wins across sessions **by design** — it is the _only_ deliberately cross-session write
in the product, and it feeds nothing but the legacy fallback for a device that has never declared a
language. OTP and password-reset emails do **not** read it: they render in the locale of the
request that asked for them (`currentLocale()` in
`apps/auth-service/src/messaging/publish-*-otp.ts`).

---

## 5. Website (Next.js — no local content DB)

Everything hangs off one Redux value, `ui.locale`, and one component,
`src/component/common/LocaleSync.tsx`, which is the single place a language change fans out. Keep
it that way: both language controls (Settings → General and the header dropdown) only write
localStorage + Redux, and every consequence is derived here.

**Shipped.** C1 was already there (`src/services/BaseService.ts:451` stamps `x-lang` from Redux) and
so were C2/C3 (`applySocketLocale` in `src/hooks/useSocketConnection.ts`). Three files closed the
rest:

### 5.1 `src/controller/devices/devices.apiType.ts`

`lang?: string` on `RegisterDevicePayload`.

### 5.2 `src/component/common/FcmRegistrar.tsx` — C4 and C5

The registrar reads `ui.locale` itself rather than having `LocaleSync` fire a second network call,
which keeps a registration's inputs in the component that owns it.

```tsx
const locale = useAppSelector((state) => state.ui.locale);
…
// Locale is PART of the registration, so a language change is a NEW registration.
// Without it in the key the guard swallows the re-POST and the tray keeps the old
// language until the FCM token itself rotates.
const registrationKey = `${authToken}:${token}:${locale}`;
if (lastRegistered === registrationKey) return;
lastRegistered = registrationKey;
registerDevice(
    { token, platform: "WEB", lang: locale, ...(deviceId ? { deviceId } : {}) },
    {
        onSuccess: () => rememberFcmToken(token),
        // Clear the guard so the next remount retries — otherwise one failed POST
        // pins this browser to its previous push language. This is C5 on web: the
        // component remounts on ordinary navigation.
        onError: () => { if (lastRegistered === registrationKey) lastRegistered = null; },
    }
);
```

### 5.3 `src/component/common/LocaleSync.tsx`

Two fixes, both about consistency rather than the language itself:

- **`cancelQueries()` before `invalidateQueries()`.** `BaseService` stamps `x-lang` at send time, so
  a request already in flight carries the OLD language. Letting it settle repopulates the cache with
  previous-language text moments after the invalidation cleared it — a stale screen no further user
  action repairs.
- **A `storage` listener dispatching `setLocale`.** Sibling tabs share one session, one device token
  and therefore ONE push language, but Redux is per tab — without this, a change in tab A leaves tab
  B rendering the old language against a token registered in the new one. `storage` fires only in
  the _other_ tabs, so there is no loop.

### 5.4 Web notes

- **The web has no content database.** IndexedDB (`src/services/offlineDatabase.ts`) holds only the
  outbox, pending read receipts and media uploads — no rendered server text — so
  `invalidateQueries()` genuinely is the whole cache story. Nothing to migrate, nothing to purge.
- **Different browsers / profiles / devices = different sessions**, different FCM tokens, and
  therefore genuinely independent languages. That is the scenario working as intended.
- The **service worker** renders the tray notification straight from the FCM payload, so the
  per-token locale from §3 fixes background pushes with no service-worker change.

---

## 6. Mobile (Android + iOS) — with a local database

Same five obligations. The difference is that mobile **caches server-rendered strings on disk**, so
a language change makes part of that cache silently wrong in a way no component can detect.

### 6.1 The one rule for the offline DB

> **Every cached string that came from the server carries the locale it was rendered in. A row whose
> `renderedLocale` differs from the current locale is stale — treat it exactly like a row that
> failed validation.**

Add one column to every table holding server-rendered text:

```sql
ALTER TABLE notifications      ADD COLUMN rendered_locale TEXT;  -- title, body, resolution
ALTER TABLE conversations      ADD COLUMN rendered_locale TEXT;  -- last-message preview
ALTER TABLE messages           ADD COLUMN rendered_locale TEXT;  -- SYSTEM rows only
```

Do **not** add it to user-authored content. A chat message someone typed is authored content and is
never translated — same rule the backend applies to admin announcements and moderator warnings.

### 6.2 What is re-renderable locally vs. what must be refetched

| Content                                                                   | Can mobile re-render offline?                                                                 | How                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **SYSTEM chat lines** ("X added Y", "Auto-delete set to 24h", call cards) | **Yes**                                                                                       | the message DTO already ships `systemEvent` + `systemData` (`chat-message.serializer.ts:870`). Persist both, keep a local catalog keyed by `systemEvent`, and re-render instantly with zero network. Fall back to the server-rendered string for an event the local catalog does not know. |
| **Notification Center rows** (title / body / resolution)                  | **No**                                                                                        | the replay ticket (`copyRef`/`dataRef`) is deliberately **stripped before it reaches clients** (`notification-serializer.ts`, `INTERNAL_DATA_DIRECTIVES`) — a client reading it would be re-implementing the server copy catalog. Refetch.                                                 |
| **Conversation / community list previews**                                | **No** (private + group are rebuilt server-side; community previews are still baked — see §8) | Refetch.                                                                                                                                                                                                                                                                                   |
| **Push tray text**                                                        | N/A — already delivered                                                                       | nothing to do; a banner already in the tray keeps its language                                                                                                                                                                                                                             |

### 6.3 The refetch on language change

`GET /notifications/sync` is a **delta** endpoint keyed on `updatedAt`. A language change mutates
nothing server-side, so delta sync returns **zero rows** — do not expect it to repair the cache.
Use the full list endpoint:

```
on language change:
  db.execute("UPDATE notifications SET rendered_locale = NULL WHERE rendered_locale <> :new")
  db.execute("UPDATE conversations SET rendered_locale = NULL WHERE rendered_locale <> :new")

  if (online):
      GET /notifications?limit=<page>        with x-lang: <new>   → upsert page 1, stamp locale
      GET /conversations?limit=<page>        with x-lang: <new>   → upsert page 1, stamp locale
      remaining pages repaired lazily on scroll (a row with rendered_locale = NULL
      that scrolls into view triggers its page fetch)
  else:
      keep showing the stale text and set a "locale repair pending" flag;
      run the same block on the next successful connect
```

Rules that matter:

- **Never blank a row you cannot re-render.** Stale text in the previous language is strictly better
  than an empty cell — this is the offline case and it will happen.
- **Only page 1 is urgent.** The user is looking at the top of the list. Repair the rest on scroll;
  a language change is rare and deliberate.
- **Read state, badges, ordering and cursors are locale-independent** — never reset them as part of
  a locale repair. Re-upsert by `id`, do not clear the table.
- Stamp `rendered_locale` at **write** time from the `x-lang` you actually sent on that request, not
  from the current UI locale. A response can land after a second switch.

### 6.4 Android

```kotlin
// 1. OkHttp interceptor — C1, every REST call
class LangInterceptor(private val prefs: LocalePrefs) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response =
        chain.proceed(
            chain.request().newBuilder()
                .header("x-lang", prefs.locale)   // "en" | "vi" | "th"
                .build()
        )
}

// 2. Socket.IO handshake — C2, BOTH auth and query
val opts = IO.Options().apply {
    auth  = mapOf("token" to accessToken, "lang" to prefs.locale)
    query = "token=$accessToken&lang=${prefs.locale}"
}

// 3. Language change — C3 + C4 + repair
fun onLocaleChanged(next: String) {
    prefs.locale = next                                   // per-install persistence

    // C3: retarget every open namespace, and make it survive a reconnect.
    listOf(chatSocket, communitySocket, notifySocket, streamSocket).forEach { s ->
        s.io().opts.auth  = (s.io().opts.auth ?: emptyMap()) + ("lang" to next)
        s.io().opts.query = withLang(s.io().opts.query, next)
        if (s.connected()) s.emit("locale:set", mapOf("lang" to next))
    }

    // C4: same token, new language. Idempotent upsert on the server.
    scope.launch { registerLocale(next) }

    // Local DB repair (§6.3) + account fallback (best-effort)
    scope.launch { localeRepair.run(next) }
    scope.launch { runCatching { api.patchMySettings(AppSettings(language = next)) } }
}

// C4 + C5 share ONE function, and it records what the server was actually told.
// Without `lastRegisteredLocale` a failed call is invisible and this device stays
// on its old push language until the FCM token happens to rotate.
suspend fun registerLocale(lang: String) {
    runCatching {
        api.registerDevice(RegisterDeviceBody(
            token = FirebaseMessaging.getInstance().token.await(),
            platform = "ANDROID",
            deviceId = stableDeviceId(context),   // Settings.Secure.ANDROID_ID
            lang = lang
        ))
        prefs.lastRegisteredLocale = lang
    }
}

// C5: cheap convergence. Registration is an idempotent upsert keyed on the token,
// so the no-drift case costs nothing and the drift case repairs itself.
fun onAppForegroundOrSocketConnect() {
    if (prefs.locale != prefs.lastRegisteredLocale) {
        scope.launch { registerLocale(prefs.locale) }
    }
}
```

Android specifics:

- **`onNewToken` must also send `lang`.** FCM rotates tokens; a rotation that re-registers without
  the language would leave the new token on the account fallback until the next language change.
- **Data-only pushes**: chat `MESSAGE` pushes are data-only on Android and the app builds the
  notification itself — that path uses the payload's `title`/`body`, which the server now renders in
  this device's locale. Do not re-translate them locally, and do not substitute your own strings:
  they may contain a sender name.
- **`deviceId`** stays the stable install id. It is _not_ the server's `Session.deviceId` (that is a
  `sha256(userAgent|ip)` fingerprint) — the link back to a session is `sessionId`, which the server
  derives from the JWT. Never send `sessionId` yourself.
- Do not rely on the OS locale. `Accept-Language` is the _phone's_ language; the user picked a
  different one in-app, and `x-lang` is the only channel that says so.

### 6.5 iOS

```swift
// 1. URLSession / Alamofire adapter — C1
request.setValue(LocaleStore.current.rawValue, forHTTPHeaderField: "x-lang")

// 2. Socket.IO handshake — C2, BOTH auth and query
let manager = SocketManager(socketURL: url, config: [
    .connectParams(["token": accessToken, "lang": LocaleStore.current.rawValue]),  // query
    .extraHeaders(["x-lang": LocaleStore.current.rawValue])                        // polling only
])
// plus `auth` in the connect payload:
socket.connect(withPayload: ["token": accessToken, "lang": LocaleStore.current.rawValue])

// 3. Language change — C3 + C4 + repair
func onLocaleChanged(_ next: SupportedLocale) {
    LocaleStore.current = next                       // UserDefaults, per install

    for socket in [chatSocket, communitySocket, notifySocket, streamSocket] {
        rewriteConnectParams(socket, lang: next)     // survives reconnect
        if socket.status == .connected {
            socket.emit("locale:set", ["lang": next.rawValue])
        }
    }

    Task {
        await registerLocale(next)                   // C4
        await localeRepair.run(next)
        try? await api.patchMySettings(.init(language: next.rawValue))
    }
}

// C4 + C5 share one function. BOTH tokens carry the language: FCM for banners,
// PushKit for call rings — they are two separate DeviceToken rows.
// `lastRegisteredLocale` is what makes C5 possible at all: without a record of
// what the server was told, a failed call is invisible.
func registerLocale(_ lang: SupportedLocale) async {
    try? await api.registerDevice(.init(token: fcmToken,  platform: "IOS",
                                        tokenType: "FCM",  deviceId: deviceId, lang: lang.rawValue))
    if let voipToken {
        try? await api.registerDevice(.init(token: voipToken, platform: "IOS",
                                            tokenType: "VOIP", deviceId: deviceId, lang: lang.rawValue))
    }
    LocaleStore.lastRegistered = lang
}

// C5: on didBecomeActive and on socket connect.
func reassertLocaleIfDrifted() {
    guard LocaleStore.current != LocaleStore.lastRegistered else { return }
    Task { await registerLocale(LocaleStore.current) }
}
```

iOS specifics:

- **Register the VoIP (PushKit) token too.** It is a separate `DeviceToken` row with
  `tokenType: "VOIP"` and its own `locale` column; miss it and the CallKit ring's copy stays on the
  account fallback.
- **`mutable-content` / Notification Service Extension**: the extension may rewrite the body for
  media previews. It must use the server-supplied `title`/`body` verbatim as its base — those are
  already in this device's language. Do not localize from the extension's own bundle; the extension
  has no idea which session it belongs to.
- **CallKit's caller display name is a name**, never product copy — do not translate it.
- **Do not use `Locale.preferredLanguages`** for `x-lang`. It is the device's language, not the
  session's.

---

## 7. End-to-end: the exact reported scenario

| Session | Device         | Language | REST (`x-lang`) | Socket (`auth.lang`) | `DeviceToken.locale` |
| ------- | -------------- | -------- | --------------- | -------------------- | -------------------- |
| S1      | Android A      | vi       | `vi`            | `vi`                 | `vi`                 |
| S2      | Android B      | vi       | `vi`            | `vi`                 | `vi`                 |
| S3      | iPhone         | th       | `th`            | `th`                 | `th`                 |
| S4      | Chrome desktop | en       | `en`            | `en`                 | `en`                 |
| S5      | Safari laptop  | en       | `en`            | `en`                 | `en`                 |

Account `AppSettings.language` = whatever was chosen most recently. It decides **only** OTP emails.

**Someone sends this user a message.** One consumer, one `pushToUser` call, one inbox row. The
device fan-out renders three views (`vi`, `th`, `en`) and sends five pushes: two Vietnamese, one
Thai, two English. Each session opening the app fetches the notification list with its own
`x-lang`, and the row's replay ticket rebuilds the same sentence in that session's language.

**S4 switches English → Thai, mid-stream.**

| #   | Effect                                               | Latency                                                             | Mechanism                                                                                                   |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | S4's UI chrome                                       | immediate                                                           | local catalog                                                                                               |
| 2   | S4's live SYSTEM messages, list bumps, socket acks   | immediate, no reconnect                                             | `locale:set` mutates `socket.data.locale`; `scopeSocketLocale` re-reads it on the next packet               |
| 3   | S4's next REST response (history, notification list) | next request                                                        | `x-lang: th`                                                                                                |
| 4   | S4's already-fetched cached text                     | after invalidate + refetch (web: `invalidateQueries`; mobile: §6.3) | —                                                                                                           |
| 5   | S4's **push tray**                                   | next push after the `POST /devices` lands                           | `DeviceToken.locale = "th"` for that token only                                                             |
| 6   | S1, S2, S3, S5                                       | **unchanged**                                                       | their token rows and their sockets were never touched                                                       |
| 7   | OTP / password-reset emails                          | **already per request**                                             | rendered in the locale of the request that asked for them, not from any stored field                        |
| 8   | The account `AppSettings.language` field             | now `th`                                                            | last-writer-wins, by design; feeds only the legacy fallback for a device that has never declared a language |

The only lag is #5, bounded by one HTTP round-trip, and pushes already in flight or already in the
tray keep their old language — unavoidable and correct.

---

## 8. Known limits — say these out loud before someone files them as bugs

1. **One FCM token = one language.** The token is the primary key. Two accounts signed into the same
   browser share a token, and re-registering moves ownership — so the second sign-in's language
   wins for that device. Real per-install use (one login per app install) is unaffected.
2. **Community list previews are still baked English.** `Community.lastActivityPreview` /
   `SelfPreview` / `TargetPreview` are three pre-rendered strings written from `community.activity`,
   which carries no canonical event to re-render from. Fixing it needs a proto field + two columns +
   a serializer change — a separate ticket. Private and group previews are already localized.
3. **`GET /notifications/sync` will not repair a locale change** (§6.3). It is keyed on `updatedAt`
   and a language change mutates nothing.
4. **Rows with no replay ticket keep their stored text**: rows written before tickets existed, and
   rows whose producer passed raw `title`/`body` — admin announcements, ban notices, a moderator's
   free-text warning. That text is **authored content**, not product copy, and must never be
   re-rendered. Same rule as a chat message.
5. **Only `en`, `vi`, `th` exist** (`SUPPORTED_LOCALES`). Anything else is ignored and the previous
   value kept. Adding a locale turns every missing catalog entry into a compile error — that error
   list is the work queue.
6. **`DEFAULT_LOCALE` is `vi` in production.** Every "why is it Vietnamese?" report traces back to a
   client that did not send its language somewhere. Check C1–C5 before anything else — and for push
   specifically, read `locales=` on the `[push:deliver]` line, which names the rung each token used.
7. **A device on the `account` rung inherits another session's choice.** That is the deliberate
   legacy fallback, not a bug: the alternative — falling through to `DEFAULT_LOCALE` — would flip
   every pre-upgrade device to Vietnamese in production. It disappears as clients adopt C4;
   `locales=` is how you watch that happen.
8. **Push image URLs are presigned for 1 h while FCM's TTL is 24 h** — unrelated to language, but it
   is the other thing that looks like a push bug.

---

## 9. Rollout order

Each step is independently shippable and backward compatible; old clients keep the previous
behaviour (account language) at every point.

1. ~~**Backend** — §3.1 (a)–(f) + the tests in §3.2.~~ **Shipped.** Deploying it needs
   `pnpm --filter @aimess/notifications-service db:push` + `db:generate` (MongoDB, nullable column —
   no migration) and a `packages/constants` rebuild. With no client sending `lang`, every row keeps
   `locale = null` and every push falls back to the account language, i.e. the previous behaviour
   exactly.
2. ~~**Web** — §5.1–§5.3.~~ **Shipped.** Three files.
3. **Android / iOS** — C1–C5 (§6.4 / §6.5). Verify with two devices on one account in two languages
   before touching the local DB.
4. **Mobile local DB** — the `rendered_locale` column and the repair pass (§6.1–§6.3). Last, because
   it is the only step that touches persisted user data.

### Acceptance checklist

- [ ] Two devices, one account, different languages → one message produces two pushes in two languages.
- [ ] A device that never sent `lang` still receives pushes in the account language (no regression),
      and `[push:deliver] … locales=` names it `account`.
- [ ] Language change on device A does not alter device B's socket, REST, or push language.
- [ ] `locale:set` flips live SYSTEM messages with no reconnect and no reload.
- [ ] Kill the connection after a language change, reconnect → the new language survives (proves the
      stored `auth`/`query` were rewritten, not just the live packet).
- [ ] Send an unsupported code (`"fr"`, `"hi"`) → the previous language is kept, **not** `vi`.
- [ ] Switch language, kill the app, receive a push → new language.
- [ ] Go offline, switch language, force-quit, relaunch online → C5 re-registers and the next push is
      correct (this is the one that fails if `lastRegisteredLocale` was never recorded).
- [ ] Sign out on a device and sign in as a DIFFERENT account with an older build → the new owner
      does not inherit the previous owner's push language.
- [ ] Mobile: switch language while offline → old text stays visible, repairs on reconnect; read
      state, badges and ordering unchanged.
- [ ] Notification Center rows written months ago in Vietnamese read in English after a switch
      (replay ticket), while an admin announcement keeps its authored text.
