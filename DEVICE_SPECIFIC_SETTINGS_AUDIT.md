# Device-Specific Settings & Language/System-Message Translation Audit

Repos audited: `aimess_backend` (this repo), `aimess_website` (Next.js frontend). Read-only audit, no code changed.

> **Status update (2026-08-17, after the fix pass).** Findings 1–4 of §5 are fixed; the rest of this
> document is the original audit and is left as written. What shipped: the frontend sends `lang` in
> the socket `auth` **and** `query` and emits `locale:set` on a language change (§12/§13); the
> gateway reads those ahead of the headers and updates `socket.data.locale` in place on every
> namespace (§11); the frontend persists `AppSettings.language`, which nothing had ever written, so
> push and OTP copy follow the user's actual choice (§5.4); and the private/group list preview now
> carries `systemEvent`/`systemData` and is rebuilt per viewer on both the REST inbox and the
> `conv:updated`/`community:updated` bump (§5.3, §11, §13). **Not done:** the device-scoped
> `DeviceToken.locale` column (§10/§11/§14) — language stays account-level for delivery and
> device-level for display, which is the pre-existing product design; and the community-service
> list preview, which needs canonical event data across a service boundary (see `docs/I18N.md`
> known limitation #1).

Re-verified against `rajesh-dev` on 2026-08-18. Every finding below was re-confirmed at the cited location; nothing has been fixed since the first pass. Specifically still true: `useSocketConnection.ts:75-76` sends only `{ token, access_token }`; `auth.middleware.ts:67-71` and `:128-132` resolve `socket.data.locale` from handshake headers only; `SettingsGeneralPanel.tsx:106-107` writes only localStorage + Redux; `DeviceToken` (`apps/notifications-service/prisma/schema.prisma:22-47`) still has no `locale` column; `getUserLocale()` (`notification-settings.service.ts:91-93`) still reads `AppSettings.language`; `inbox.service.ts:330-335` still passes `lastMessagePreview` through verbatim; `SUPPORTED_LOCALES` is still `["vi","en","th"]` (no `hi`).

---

## 1. Executive Summary

Language today is **accidentally device-specific on the frontend** (stored only in `localStorage`, never synced to the account) and **account-specific in the backend** (`AppSettings.language`, one row per `userId`), and the two never talk to each other except through a per-request `x-lang` header. That mismatch, not a single bug, is the root cause of the Thai system-message problem:

1. Live system messages delivered over the open Socket.IO connection are personalized using `socket.data.locale`, which is captured **once at handshake** from the `x-lang`/`Accept-Language` HTTP header — and the frontend's socket client **never sends `x-lang`** at all (only an auth token). So live system messages use the browser's `Accept-Language` or the server default, never the language the user picked in Settings.
2. Inbox/community list previews (`lastMessagePreview` / `lastMessage`) are baked into English (`STORED_TEXT_LOCALE`) at write time and **never rebuilt per viewer** on read — a documented, separate gap.
3. Push notifications resolve locale from `AppSettings.language` in the DB — a field the frontend **never writes** (language selection is 100% client-local), so push copy is stuck on whatever default the DB row has.
4. There is no per-device storage for language anywhere in the schema — the one thing that already exists to hang it off (`Session` / `DeviceToken`, both keyed by device) carries no locale column.

The backend's core in-room message-history translation (REST fetch + socket `message:new`) is architecturally sound — it already re-renders `systemEvent`/`systemData` per request using `currentLocale()`. The bug is in the surfaces that bypass that pipeline: socket handshake locale, list previews, and push.

---

## 2. Current Settings Architecture

Two independent settings stores exist, not one:

- **Backend (`aimess_backend/apps/user-service`)**: five Prisma models (`PrivacySettings`, `ChatSettings`, `AppSettings`, `NotificationSettings`, `LiveStreamSettings`), all keyed 1:1 by `userId` — **account-wide only**. Exposed via `GET/PATCH /users/settings/me`.
- **Frontend (`aimess_website`)**: a parallel, partially-overlapping settings surface. Some panels call the backend API (Notifications, Chat, Privacy). Others — **Language, Theme, Wallpaper** — are purely client-side, `localStorage` only, with **no backend call at all**.

There is no device/session-scoped settings model in the backend. The only device-scoped tables are `Session` (auth-service, device identity/lifecycle) and `DeviceToken` (notifications-service, push address book) — neither has a settings/preference field.

---

## 3. Complete Settings Inventory

| Setting                                                                                                   | Storage                                                                                                           | Persisted to backend?                             |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Language                                                                                                  | `localStorage["locale"]` (FE) mirrored to Redux `ui.locale`; separately `AppSettings.language` (DB, unused by FE) | No (FE never calls the settings API for language) |
| Theme                                                                                                     | `localStorage["theme"]` (FE); separately `AppSettings.theme` (DB, unused by FE)                                   | No                                                |
| Chat wallpaper (+ custom uploads, blur)                                                                   | `localStorage["chat-wallpaper"]`, `localStorage["chat-wallpaper-library"]` (base64 data URLs)                     | No — no upload endpoint exists                    |
| Data-usage figures shown in Settings                                                                      | Hardcoded UI constants                                                                                            | N/A, not real data                                |
| Notification toggles (chat/call/friendRequest/system/community/liveStream), quiet hours                   | `NotificationSettings` (DB)                                                                                       | Yes, via `PATCH /users/settings/me`               |
| Notification preview on lock screen (`showPreview`)                                                       | `NotificationSettings.showPreview` (DB, account-wide)                                                             | Yes                                               |
| Typing indicators, read receipts, chat auto-delete timer                                                  | `ChatSettings` (DB)                                                                                               | Yes                                               |
| Privacy (who can find/message/see-online/view-profile/call me, call allow-list, block list)               | `PrivacySettings` + `CallAllowedFriend` (DB)                                                                      | Yes                                               |
| Livestream default video quality                                                                          | `LiveStreamSettings` (DB)                                                                                         | Yes                                               |
| Connected devices / sessions list                                                                         | `Session` (auth-service DB), read/revoke only                                                                     | Yes (not a preference, device identity+lifecycle) |
| Push device tokens                                                                                        | `DeviceToken` (notifications-service DB)                                                                          | Yes (not a preference)                            |
| Sound, vibration, media auto-download, accessibility, call-specific prefs beyond privacy's `whoCanCallMe` | Not found anywhere in either repo                                                                                 | N/A                                               |
| Last-selected settings tab/nav                                                                            | Not found                                                                                                         | N/A                                               |

---

## 4. Device-Specific vs Account-Specific Classification

| Setting                                                         | Current Storage                                                                | Should Be Device-Specific?    | Reason                                                                                                                                                                                | Required Change                                                                                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Language / locale**                                           | FE: localStorage only. BE: `AppSettings.language`, account-wide, unused by FE. | **Yes**                       | Display language is a device/UI preference (screen size, OS locale, who's physically using that device) — the task's own example (iPhone=Thai, Android=default) is the textbook case. | Add a `locale` column to a device-scoped table (`Session` or `DeviceToken`); send `x-lang` on socket handshake; resolve push locale per target device, not per account. |
| **Theme (light/dark/auto)**                                     | localStorage only, correctly unsynced today.                                   | **Yes**                       | Screen/ambient-light dependent, legitimately different per device.                                                                                                                    | None — current behavior is already correct. Retire the unused `AppSettings.theme` DB field or wire it as a fallback only, not authoritative.                            |
| **Chat wallpaper**                                              | localStorage only, correctly unsynced today.                                   | **Yes**                       | Local image assets, device storage/bandwidth dependent.                                                                                                                               | None — current behavior already correct.                                                                                                                                |
| **Livestream default video quality**                            | `LiveStreamSettings`, account-wide.                                            | **Yes**                       | Bandwidth/device capability varies per device (mobile data vs. desktop wifi); syncing forces a phone onto a laptop's quality choice.                                                  | Move to a device-scoped store, or leave account-level as a "default new-device value" only.                                                                             |
| **Notification toggles + quiet hours**                          | `NotificationSettings`, account-wide.                                          | **No**                        | These express "how much does this account want to be notified," not a device capability; a user expects "mute system notifications" to hold everywhere.                               | None.                                                                                                                                                                   |
| **Typing indicators, read receipts, auto-delete timer**         | `ChatSettings`, account-wide.                                                  | **No**                        | Protocol-visible behavior other users rely on ("do they see my typing?") — must be consistent regardless of which device is active.                                                   | None.                                                                                                                                                                   |
| **Privacy settings (who can find/message/call me, block list)** | `PrivacySettings`, account-wide.                                               | **No**                        | Security/visibility boundary tied to the identity, not the device.                                                                                                                    | None.                                                                                                                                                                   |
| **Notification preview (`showPreview`)**                        | `NotificationSettings.showPreview`, account-wide.                              | **Yes** (lower priority)      | "Hide message text on the lock screen" is a shoulder-surfing defence about _this screen_ — a shared living-room tablet needs it, a personal laptop does not.                          | Same device-scoped store as language; keep the account value as the default for new devices.                                                                            |
| **Sound / vibration / media auto-download / accessibility**     | Not implemented.                                                               | **Yes, if added**             | All are hardware/usage-context dependent (silent office phone vs. loud tablet at home).                                                                                               | Design as device-scoped from the start; do not add to the account-wide `AppSettings`/`NotificationSettings` models.                                                     |
| **Connected-devices session list**                              | `Session`, correctly device-scoped.                                            | N/A (already device identity) | —                                                                                                                                                                                     | None.                                                                                                                                                                   |

---

## 5. Current Problems / Gaps

1. **Frontend never persists language to the backend.** `SettingsGeneralPanel.tsx` / `LanguageDropdown.tsx` only call `setClientLocale()` (localStorage) + Redux `setLocale()`. No API call. `AppSettings.language` in the DB is dead weight from the frontend's perspective — nothing writes it except whatever created the row (defaults to `"en"`).
2. **Socket.IO handshake never sends `x-lang`.** `useSocketConnection.ts` only sets `auth: { token, access_token }` / `query: { token }`. Backend `auth.middleware.ts` resolves `socket.data.locale` from handshake `headers["x-lang"]`/`Accept-Language`, which the FE never sets — so it falls through to whatever the browser's own `Accept-Language` header is (not the app's selected language), captured once and never refreshed for the life of the connection.
3. **List/inbox previews are frozen in English.** `lastMessagePreview`/`lastMessage` store pre-baked `STORED_TEXT_LOCALE` ("en") text with no `systemEvent`/`systemData`; the inbox serializer and `conv:updated`/`community:updated` socket bump both pass it through verbatim. Documented in `docs/I18N.md` (lines ~390-407) as a known, unresolved gap.
4. **Push notification locale is stuck.** `pushToUser` resolves locale via `AppSettings.language` in the DB, through `getUserLocale()` — which the FE never updates, so push copy uses the DB default forever regardless of what language the user actually picked.
5. **No device-scoped settings storage exists at all.** `Session` and `DeviceToken` are pure identity/lifecycle tables; adding device-specific language (or theme/quality) requires a schema change, not just a routing fix.
6. **Two parallel "settings" concepts on the frontend with divergent persistence** (Language/Theme/Wallpaper = local-only vs. Notifications/Chat/Privacy = backend-synced) is not documented anywhere, and is invisible to a developer reading only the backend.

---

## 6. Language Architecture Audit

Full trace, backend side (confirmed by direct file/line reads):

- `packages/constants/src/locale.ts` — `SUPPORTED_LOCALES = ["vi","en","th"]`, `DEFAULT_LOCALE` ("vi" prod / "en" dev), `STORED_TEXT_LOCALE = "en"`.
- `packages/constants/src/locale-context.ts` — ambient `AsyncLocalStorage<SupportedLocale>`; `runWithLocale()`/`currentLocale()`.
- `packages/utils/src/resolve-locale.ts` — `resolveLocaleFromRequest(req)`: `x-lang` header first, then `Accept-Language`.
- `packages/utils/src/locale-middleware.ts` — `localeMiddleware`: sets `req.locale`, wraps `next()` in `runWithLocale`.
- `apps/api-gateway/src/sockets/locale-scope.ts` — `scopeSocketLocale(socket)`: per-packet `socket.use()` wraps handlers in `runWithLocale(socket.data.locale)`.
- `apps/api-gateway/src/sockets/auth.middleware.ts:61-65` — `socket.data.locale` resolved **once at handshake** from `headers["x-lang"]`/`headers["accept-language"]`, before token verification. **Not** derived from the JWT (JWT carries no locale claim).
- `packages/grpc-utils/src/index.ts` — `LOCALE_METADATA_KEY = "x-lang"`; egress gRPC calls auto-attach `currentLocale()` as metadata.

Frontend side:

- `src/i18n/config.ts` — `locales = ["en","th","vi"]`, `defaultLocale = "en"`.
- `src/i18n/locale-client.ts` — `getClientLocale()`/`setClientLocale()`: pure `localStorage["locale"]`.
- `src/component/common/LocaleSync.tsx` — on mount, seeds Redux `ui.locale` from localStorage; on change, mutates a **module-level, non-reactive** `currentLocale` variable in `src/i18n/runtime.ts` (explicitly marked with a `// ponytail: module-level locale, not reactive` comment) used by the custom `translate()` function.
- `src/services/BaseService.ts:434-436` — axios interceptor sets `x-lang` from Redux `ui.locale` on every REST call. This is the only place the selected language leaves the browser.
- `src/hooks/useSocketConnection.ts:52-77` — socket `auth`/`query` carry only the access token. **No locale field, ever.**

Where the language is "lost": between the REST layer (correctly locale-aware via `x-lang`) and the realtime layer (socket handshake locale is browser-default, not app-selected, and frozen for the connection's lifetime), and between the client and the account-level DB field that push/OTP fall back to (which the client never writes).

---

## 7. Thai Translation Issue — Root Cause

**Not one bug — three independent gaps that combine to look like "Thai doesn't work":**

1. Selecting Thai in Settings only ever writes `localStorage` + Redux. It is never sent to the backend as a persisted preference.
2. REST fetches (message history, inbox) do carry the selected language via `x-lang`, so a _fresh page load / history fetch_ of a chat room's SYSTEM message **should** render in Thai correctly — the backend rebuilds it from `systemEvent`/`systemData` using `currentLocale()` at read time.
3. **Live** system messages arriving over the already-open socket connection while the room is open use `socket.data.locale`, fixed at connection time from a header the frontend never sets — so they render in whatever the browser's own OS/browser language is (or the server default), not Thai, even though the user picked Thai in-app. This is very likely what the user is actually observing: "I set Thai, but the system message that just appeared live is still in English."
4. Independently, the inbox list preview and any push notification are also not Thai, for the separate reasons in gaps #3 and #4 of section 5.

---

## 8. System Message Translation Flow

Two write paths exist for the same information, and only one is locale-aware:

```
Action (join/leave/ban/etc.)
  → build*SystemFallbackText(systemEvent, systemData)     [English, STORED_TEXT_LOCALE, baked into the message row]
  → chat/community message row persisted with baked English text + systemEvent/systemData

READ PATH A (message history, in-room):
  REST fetch or socket message:new
  → personalize*SystemMessageForViewer(systemEvent, systemData, ..., currentLocale())
  → correctly localized per viewer                         ✔ works if x-lang/socket locale is correct

READ PATH B (list preview / bump):
  room.lastMessagePreview / room.lastMessage (baked English, no systemEvent/systemData)
  → inbox.service.ts toPrivateItem/toGroupItem — passthrough, no rebuild
  → conv:updated / community:updated socket bump — passthrough, no personalizeFn
  → ALWAYS English, regardless of viewer locale                ✘ known, documented gap

READ PATH C (push):
  pushToUser → getUserLocale(userId) → AppSettings.language (DB, account-wide, FE never writes it)
  → localized to whatever the DB default is, not the user's actual selection   ✘ gap
```

---

## 9. Multi-Device Behavior

Scenario: Account A, Device 1 = English, Device 2 = Thai, Device 3 = Hindi (not currently supported, no `hi` locale in `SUPPORTED_LOCALES`).

| Layer                             | Current behavior                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST (each device's own requests) | Works correctly today — each device's own `x-lang` header drives its own response language. This is the one place multi-device already works, by accident of being stateless per-request.                                                                                                                                                                     |
| Socket.IO live broadcast          | **Broken.** `emitPersonalizedSender` does iterate per connected socket and does read each socket's own `socket.data.locale` (so it does support divergent per-device locale _in principle_) — but since the FE never sends `x-lang` at handshake, every device converges on the same wrong source (browser `Accept-Language`), not the app-selected language. |
| Push notifications                | **Broken for divergence.** `AppSettings.language` is one value for the whole account; both Device 1 and Device 2's push copy use the same DB value, so they cannot legitimately differ per the scenario.                                                                                                                                                      |
| JWT / session                     | No locale claim exists; nothing to update, no gap here — locale was never meant to live in the token.                                                                                                                                                                                                                                                         |
| Redis cache                       | `notif:settings:<userId>` caches the account-wide notification settings bundle (including `language`) — a single cache entry per account, consistent with the account-wide model, but wrong for the target per-device model.                                                                                                                                  |
| Database                          | No per-device locale column exists on `Session` or `DeviceToken`.                                                                                                                                                                                                                                                                                             |

**Conclusion: the architecture (per-request `x-lang`, per-socket `socket.data.locale`, ambient `AsyncLocalStorage`) already supports per-device divergence in principle for REST and socket personalization — it is not built to carry a _stored_ per-device preference, only a _per-request_ one.** Push and list-preview rebuild need a real per-device (or at minimum account-default) locale source since they have no live request to read `x-lang` from.

---

## 10. Recommended Architecture

**Language stays "sent as a per-request signal" (Option B/hybrid already in place for REST/socket), not baked server-side once.** Concretely:

- Keep `x-lang` header + ambient `AsyncLocalStorage` + `socket.data.locale` for anything that happens _during_ a live request/connection (REST fetch, socket `message:new`) — this is already correct and should not change.
- For anything that must localize **without** an active request (push, list preview rebuild-on-demand, OTP/email), add an explicit **per-device stored locale**, not a per-account one:
  - Add `locale` to the notifications-service `DeviceToken` model (it is already the natural "which device do I need to reach" table for push) and/or the auth-service `Session` model.
  - **Key it on `sessionId`, not `deviceId`.** The two `deviceId` fields in this system are unrelated: `DeviceToken.deviceId` is a client-generated opaque string, while `Session.deviceId` is a server-side `sha256(userAgent|ip)` fingerprint — the schema comment at `apps/notifications-service/prisma/schema.prisma:31-37` states outright that they never match. `sessionId` is the one identifier that already spans all three layers: it is a JWT claim, so REST has it, `socket.data.sessionId` has it, and `DeviceToken.sessionId` has it. Any device-locale lookup keyed on `deviceId` will silently miss.
  - Update it whenever the client sends `x-lang` (piggyback on any authenticated request from that device/session, or an explicit "register device locale" call at login/app-start), not only through the Settings screen.
- Fix the frontend socket client to send `x-lang` (or a custom locale field) in the socket `auth`/`query` payload, sourced from the same value it already sends on REST (`Redux ui.locale`), and reconnect (or re-emit an "update my socket locale" event) whenever the user changes language in Settings without a full page reload.
- Fix list previews per the already-documented plan in `docs/I18N.md`: carry `systemEvent`/`systemData` in `lastMessagePreview`/`lastMessage`, rebuild with `currentLocale()` in the inbox serializer, and add a `personalizeFn` for `conv:updated`/`community:updated`.
- Retain `AppSettings.language` only as an account-level _fallback default_ (e.g., for OTP emails, which are truly deviceless) — do not treat it as authoritative once per-device locale exists.

---

## 11. Required Backend Changes

- `notifications-service` Prisma schema: add `locale String?` to `DeviceToken`. New migration. Rows are located by `sessionId` (already indexed via `@@index([userId, sessionId])`), never by `deviceId` — see §10.
- `apps/notifications-service/.../device.routes.ts` (`registerDevice`): accept and store `locale` from the client at registration/refresh.
- `apps/notifications-service/.../push.service.ts` (`pushToUser`): resolve locale from the target `DeviceToken.locale` first, falling back to `AppSettings.language` only if the device row has none.
- `apps/api-gateway/src/sockets/auth.middleware.ts`: no change needed to the resolution order, but confirm it prioritizes an explicit client-sent locale field over `Accept-Language` (already does, if the client actually sends it).
- Add a lightweight "update socket locale" handler (or require reconnect) so a language change mid-session updates `socket.data.locale` without forcing a full logout/login.
- `inbox.service.ts` (`toPrivateItem`/`toGroupItem`): rebuild SYSTEM preview text from `systemEvent`/`systemData` via `currentLocale()` instead of passthrough — requires `lastMessagePreview`/`lastMessage` to store `systemEvent`/`systemData` (see §14).
- `publish-conv-updated.ts` / community equivalent: carry `systemEvent`/`systemData`, not baked text.
- `apps/api-gateway/.../chat.ns.ts` and `community.ns.ts`: add a `personalizeFn` for `conv:updated` / `community:updated` mirroring the one already used for `message:new`.

## 12. Required Frontend Changes

- `useSocketConnection.ts`: add the current locale (from `store.getState().ui.locale`, same source `BaseService.ts` already uses) to the socket `auth`/`query` payload as `x-lang` (or a dedicated field the backend expects).
- `LocaleSync.tsx` / language-change handler: on language change, either force a socket reconnect or emit an explicit "locale changed" event so `socket.data.locale` updates without waiting for a fresh connection.
- Optionally: call the settings API to persist language as a device-tagged preference (new endpoint, see §15) so device locale survives `localStorage` being cleared and is available to push (§11) — needs a device identifier the client already has (the `deviceId` used for `Session`/`DeviceToken`).
- No change needed for Theme/Wallpaper — already correctly device-local.

## 13. Required Socket/Realtime Changes

- Client sends `x-lang` (or equivalent) at handshake — see §12.
- Server-side, no structural change to `scopeSocketLocale`/`emitPersonalizedSender` — they already personalize per connected socket correctly; they just need real input.
- Add `personalizeFn` for `conv:updated`/`community:updated` (see §11) so the live bump — not just the initial history load — is localized.

## 14. Required Database/Redis Changes

- New column: `DeviceToken.locale` (notifications-service, MongoDB — add to Prisma schema + migration).
- Extend `lastMessagePreview`/`lastMessage` JSON shape on room models (chat-service) to include `systemEvent`/`systemData`, not just baked `text`.
- Redis: `notif:settings:<userId>` cache either needs a per-device key variant (e.g. `notif:settings:<userId>:<deviceId>`) or the push-path locale lookup needs to skip the account-wide cache when a device-level locale is present.

## 15. API Contract Changes

- `POST /notifications/devices` (device registration) — add optional `locale: SupportedLocale` field.
- Consider a new `PATCH /users/settings/device` (or extend registration) if the product wants the language choice to be explicitly persisted per device rather than only inferred from the most recent `x-lang` seen.
- No breaking change to existing `GET/PATCH /users/settings/me` — `AppSettings.language` remains but is redefined as "fallback default," documented as such.

## 16. Migration / Backward Compatibility Considerations

- Existing `DeviceToken` rows have no `locale` — treat `null` as "unknown, fall back to `AppSettings.language`," no backfill required.
- Existing `lastMessagePreview`/`lastMessage` rows lack `systemEvent`/`systemData` — old rows keep showing baked English until a new event overwrites them; no migration needed, matches the existing `STORED_TEXT_LOCALE` philosophy already used for message bodies.
- Old app/web clients that never send a socket locale field continue to work exactly as today (fallback to `Accept-Language`/default) — purely additive.

## 17. Security Considerations

- Locale is not sensitive; no new authz surface. Ensure the new `DeviceToken.locale` and socket locale field are validated against `SUPPORTED_LOCALES` server-side (reject/ignore unknown values) rather than trusting client input verbatim, consistent with existing `resolveLocale()` validation.

## 18. Testing Scenarios

**Single device:** English→Thai, Thai→English, Hindi→Thai (blocked until Hindi is added to `SUPPORTED_LOCALES`), app restart, logout/login, token refresh — verify REST-fetched history, live socket system messages, and list preview all match the selected language after each transition.

**Multiple devices:** Device A=English, B=Thai, C=Hindi (once supported) on the same account — change language on B, verify A and C are unaffected (device isolation), verify B's push notifications and live system messages both flip to Thai, verify A's inbox preview for the same room still shows English if A never opens it (reader-side rebuild) vs. shows the writer-baked default if A does open the room fresh.

**System messages:** join/leave/add/remove/ban/unban/promote/demote, friend-request actions, group/community actions, livestream events — verify each renders correctly both (a) live via socket while the room is open, and (b) after leaving and reopening (REST refetch), and (c) in the inbox list preview, all three in the device's currently selected language.

## 19. Acceptance Criteria

- Changing language in Settings changes: in-room live system messages, REST-fetched history, list/inbox previews, and push notification copy — for that device only.
- A second device on the same account, with a different language selected, is unaffected by the first device's change.
- Clearing `localStorage` on a device does not silently revert push notifications to a stale language (device locale persisted server-side survives it).
- No regression to REST-driven translation, which already works today.

## 20. Implementation Checklist

- [ ] Add `locale` column to `DeviceToken` (+ migration), looked up by `sessionId`.
- [ ] Accept `locale` on device registration endpoint.
- [ ] Frontend: send locale on socket handshake.
- [ ] Frontend: reconnect/re-emit on in-session language change.
- [ ] Backend: push locale resolution prefers `DeviceToken.locale` over `AppSettings.language`.
- [ ] Backend: `lastMessagePreview`/`lastMessage` carry `systemEvent`/`systemData`.
- [ ] Backend: inbox serializer rebuilds SYSTEM preview text via `currentLocale()`.
- [ ] Backend: `conv:updated`/`community:updated` gain a `personalizeFn`.
- [ ] Redis cache key strategy updated for per-device push locale lookups.
- [ ] Tests per §18 added/updated.
- [ ] `docs/I18N.md` updated to close out the "list preview" known-limitation entry and document the new device-locale model.
